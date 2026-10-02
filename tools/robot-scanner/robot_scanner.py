#!/usr/bin/env python3
"""
Arachnet continuous Raspberry Pi barcode scanner.

Pipeline:
Camera Module 3 -> Picamera2 -> ZXing-C++ -> GTIN validation
-> durable SQLite queue -> evidence presign/upload/finalize
-> /api/robot/observations.

Required environment variables:
  ARACHNET_BASE_URL
  ROBOT_CODE
  ROBOT_SECRET
  LOCATION_CODE

Optional:
  ROBOT_QUEUE_DB
  EVIDENCE_DIR
  SCAN_INTERVAL
  DEBOUNCE_SECONDS
  CONFIDENCE
  ARACHNET_STORAGE_HOST
"""

import io
import json
import os
import sqlite3
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from PIL import Image
from picamera2 import Picamera2
from libcamera import controls
import zxingcpp


BASE_URL = os.environ.get("ARACHNET_BASE_URL", "http://localhost:3000").rstrip("/")
ROBOT_CODE = os.environ.get("ROBOT_CODE", "scout-001")
ROBOT_SECRET = os.environ.get("ROBOT_SECRET")
LOCATION_CODE = os.environ.get("LOCATION_CODE", "WH1-A03-RB-L04")

SCRIPT_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("ROBOT_QUEUE_DB", SCRIPT_DIR / "robot_scanner_queue.sqlite3"))
EVIDENCE_DIR = Path(os.environ.get("EVIDENCE_DIR", SCRIPT_DIR / "evidence"))

SCAN_INTERVAL = float(os.environ.get("SCAN_INTERVAL", "0.15"))
DEBOUNCE_SECONDS = float(os.environ.get("DEBOUNCE_SECONDS", "2.0"))
CONFIDENCE = float(os.environ.get("CONFIDENCE", "0.97"))
REQUEST_TIMEOUT_SECONDS = 15

# If a presigned URL comes back as localhost:9000, replace only the hostname.
# Defaults to the Arachnet API host, e.g. 192.168.3.7.
API_HOST = urlsplit(BASE_URL).hostname
STORAGE_HOST = os.environ.get("ARACHNET_STORAGE_HOST", API_HOST or "")


def log(message: str) -> None:
    print(f"[arachnet-scanner] {message}", flush=True)


def require_config() -> None:
    if not ROBOT_SECRET:
        raise SystemExit("ROBOT_SECRET is not set.")
    if not BASE_URL:
        raise SystemExit("ARACHNET_BASE_URL is not set.")
    if not LOCATION_CODE:
        raise SystemExit("LOCATION_CODE is not set.")


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS scan_events (
            event_id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            location_code TEXT NOT NULL,
            ean TEXT NOT NULL,
            barcode_format TEXT NOT NULL,
            evidence_path TEXT NOT NULL,
            confidence REAL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT
        )
        """
    )
    conn.commit()
    conn.row_factory = sqlite3.Row
    return conn


def robot_headers() -> dict:
    return {
        "X-Robot-ID": ROBOT_CODE,
        "Authorization": f"Bearer {ROBOT_SECRET}",
        "Content-Type": "application/json",
    }


class ApiCallError(Exception):
    def __init__(self, status: int, body):
        self.status = status
        self.body = body
        super().__init__(f"HTTP {status}: {body}")


def call_json(method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
    url = f"{BASE_URL}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=robot_headers())
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = {"error": {"message": raw}}
        raise ApiCallError(exc.code, body) from None


def reachable_upload_url(upload_url: str) -> str:
    parts = urlsplit(upload_url)
    if parts.hostname not in {"localhost", "127.0.0.1", "::1"} or not STORAGE_HOST:
        return upload_url

    host = STORAGE_HOST
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    if parts.port:
        host = f"{host}:{parts.port}"

    rewritten = urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))
    log(f"Rewriting storage URL host {parts.hostname} -> {STORAGE_HOST}")
    return rewritten


def upload_image(upload_url: str, image_bytes: bytes) -> None:
    upload_url = reachable_upload_url(upload_url)
    req = urllib.request.Request(
        upload_url,
        data=image_bytes,
        method="PUT",
        headers={"Content-Type": "image/jpeg"},
    )
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
        if resp.status >= 300:
            raise ApiCallError(resp.status, {"error": {"message": "image upload failed"}})


def capture_and_upload_evidence(path: str) -> str:
    image_bytes = Path(path).read_bytes()

    _, presigned = call_json(
        "POST",
        "/api/robot/evidence/presign",
        {"contentType": "image/jpeg", "maxBytes": len(image_bytes)},
    )
    asset_id = presigned["data"]["assetId"]
    upload_url = presigned["data"]["uploadUrl"]

    upload_image(upload_url, image_bytes)

    _, finalized = call_json(
        "POST",
        "/api/robot/evidence/finalize",
        {"assetId": asset_id},
    )
    status = finalized["data"]["status"]
    if status != "VERIFIED":
        raise RuntimeError(f"Evidence asset did not verify (status={status}).")

    return asset_id


def send_observation(row: sqlite3.Row) -> tuple[int, dict]:
    evidence_id = capture_and_upload_evidence(row["evidence_path"])
    payload = {
        "eventId": row["event_id"],
        "capturedAt": row["created_at"],
        "locationCode": row["location_code"],
        "ean": row["ean"],
        # MVP assumption: one successfully separated scan = one observed unit.
        # Do not use this as final quantity inference for adjacent identical products.
        "boxes": 0,
        "looseUnits": 1,
        "confidence": row["confidence"],
        "evidenceIds": [evidence_id],
        "rawPayload": {
            "source": "picamera2-zxing",
            "barcodeFormat": row["barcode_format"],
            "scannerVersion": 1,
        },
    }
    return call_json("POST", "/api/robot/observations", payload)


def mark_error(conn: sqlite3.Connection, event_id: str, exc: Exception) -> None:
    conn.execute(
        """
        UPDATE scan_events
        SET status='error', attempts=attempts+1, last_error=?
        WHERE event_id=?
        """,
        (str(exc), event_id),
    )
    conn.commit()


def mark_sent(conn: sqlite3.Connection, event_id: str) -> None:
    row = conn.execute(
        "SELECT evidence_path FROM scan_events WHERE event_id=?",
        (event_id,),
    ).fetchone()

    conn.execute(
        """
        UPDATE scan_events
        SET status='sent', attempts=attempts+1, last_error=NULL
        WHERE event_id=?
        """,
        (event_id,),
    )
    conn.commit()

    if row:
        try:
            Path(row["evidence_path"]).unlink(missing_ok=True)
        except OSError:
            pass


def process_event(conn: sqlite3.Connection, row: sqlite3.Row) -> bool:
    try:
        _, body = send_observation(row)
        data = body.get("data", {})
        replay = data.get("replay", False)
        log(
            f"{'REPLAY' if replay else 'SENT'} {row['ean']} "
            f"status={data.get('status')} expected={data.get('expectedQuantity')} "
            f"observed={data.get('observedQuantity')} difference={data.get('difference')}"
        )
        mark_sent(conn, row["event_id"])
        return True
    except Exception as exc:
        mark_error(conn, row["event_id"], exc)
        log(f"QUEUE {row['ean']} send failed: {exc}")
        return False


def flush_queue(conn: sqlite3.Connection, limit: int = 10) -> None:
    rows = conn.execute(
        """
        SELECT * FROM scan_events
        WHERE status IN ('pending','error')
        ORDER BY created_at ASC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()

    for row in rows:
        if not process_event(conn, row):
            # Network/storage is probably still down; don't hammer it.
            break


def gtin_check_digit_ok(code: str) -> bool:
    if not code.isdigit() or len(code) not in (13, 14):
        return False
    digits = [int(c) for c in code]
    body = digits[:-1]
    check = digits[-1]

    # GTIN: weights alternate from the right, starting with 3.
    total = 0
    for i, digit in enumerate(reversed(body)):
        total += digit * (3 if i % 2 == 0 else 1)

    expected = (10 - (total % 10)) % 10
    return check == expected


def classify_code(result) -> tuple[str, str] | None:
    code = result.text.strip()
    if not gtin_check_digit_ok(code):
        return None

    if len(code) == 13:
        return code, "EAN13"
    if len(code) == 14:
        return code, "ITF14"
    return None


def frame_to_jpeg(frame, quality: int = 88) -> bytes:
    image = Image.fromarray(frame)
    bio = io.BytesIO()
    image.save(bio, format="JPEG", quality=quality)
    return bio.getvalue()


def queue_scan(
    conn: sqlite3.Connection,
    code: str,
    barcode_format: str,
    frame,
) -> str:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)

    event_id = str(uuid.uuid4())
    captured_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    evidence_path = EVIDENCE_DIR / f"{event_id}.jpg"
    evidence_path.write_bytes(frame_to_jpeg(frame))

    conn.execute(
        """
        INSERT INTO scan_events
        (event_id, created_at, location_code, ean, barcode_format,
         evidence_path, confidence, status, attempts, last_error)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL)
        """,
        (
            event_id,
            captured_at,
            LOCATION_CODE,
            code,
            barcode_format,
            str(evidence_path),
            CONFIDENCE,
        ),
    )
    conn.commit()
    return event_id


def make_camera() -> Picamera2:
    picam = Picamera2()
    cfg = picam.create_video_configuration(
        main={"size": (2304, 1296), "format": "RGB888"},
        buffer_count=4,
    )
    picam.configure(cfg)
    picam.start()
    time.sleep(1)
    log("Triggering autofocus...")
    picam.set_controls({
        "AfMode": controls.AfModeEnum.Auto,
        "AfTrigger": controls.AfTriggerEnum.Start,
    })
    time.sleep(2)
    log("Camera ready; scanning for barcodes.")
    return picam


def main() -> None:
    require_config()
    conn = db_connect()

    log(
        f"Starting robot={ROBOT_CODE} location={LOCATION_CODE} "
        f"api={BASE_URL} db={DB_PATH}"
    )

    # Retry anything saved before a reboot/crash.
    flush_queue(conn)

    picam = make_camera()
    seen_once: set[str] = set()
    last_queue_flush = 0.0
    last_heartbeat = 0.0

    try:
        while True:
            frame = picam.capture_array()
            now = time.monotonic()

            try:
                results = zxingcpp.read_barcodes(
                    frame,
                    try_rotate=True,
                    try_downscale=True,
                    try_invert=True,
                )
            except Exception as exc:
                log(f"Decoder error: {exc}")
                time.sleep(SCAN_INTERVAL)
                continue

            for result in results:
                classified = classify_code(result)
                if not classified:
                    continue

                code, barcode_format = classified

                # Current MVP behavior: one observation per EAN per scanner run.
                # A stationary barcode is therefore never counted repeatedly.
                if code in seen_once:
                    continue
                seen_once.add(code)

                event_id = queue_scan(conn, code, barcode_format, frame)
                log(f"READ {barcode_format} {code} event={event_id}")

                row = conn.execute(
                    "SELECT * FROM scan_events WHERE event_id=?",
                    (event_id,),
                ).fetchone()
                process_event(conn, row)

            # Retry offline queue periodically even when no new barcode appears.
            if now - last_queue_flush >= 5.0:
                flush_queue(conn)
                last_queue_flush = now

            # Heartbeat so the terminal does not look frozen while scanning.
            if now - last_heartbeat >= 5.0:
                log("SEARCHING — camera active, waiting for a decodable barcode")
                last_heartbeat = now

            time.sleep(SCAN_INTERVAL)

    except KeyboardInterrupt:
        log("Stopping.")
    finally:
        try:
            picam.stop()
        except Exception:
            pass
        conn.close()


if __name__ == "__main__":
    main()

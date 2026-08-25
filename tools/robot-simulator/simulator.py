#!/usr/bin/env python3
"""Arachnet robot simulator.

Speaks the exact same protocol a physical robot (e.g. on a Raspberry Pi)
would use — see ../../docs/robot-protocol.md for the full spec:

  1. Authenticate every request with `X-Robot-ID` / `Authorization: Bearer
     <device-secret>` headers.
  2. POST /api/robot/evidence/presign  -> { uploadUrl, assetId }
  3. PUT the image bytes straight to `uploadUrl`.
  4. POST /api/robot/evidence/finalize -> marks the asset VERIFIED.
  5. POST /api/robot/observations      -> ingests the observation, returns
     expected/observed/difference/status/confidenceLevel.

Configuration is entirely via environment variables (see README.md), with
defaults matching the seeded demo data (`pnpm db:seed`). Uses only the
Python standard library (urllib + sqlite3) so it can run unmodified on
constrained hardware like a Raspberry Pi with no extra pip installs.

Unsent or failed events are persisted to a local SQLite file so a crash or
restart can retry them — pending/failed events from a previous run are
always retried before a new one is sent. A retried event the server
recognizes as an exact replay of one it already processed (`data.replay ===
true`) is reported as success, never as an error. A same-event-id-
different-payload conflict (HTTP 409) is detected and reported distinctly
from any other failure, and is not retried automatically (retrying it would
just get another 409 — the bug is in whatever produced the reused id).
"""

import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

BASE_URL = os.environ.get("ARACHNET_BASE_URL", "http://localhost:3000").rstrip("/")
ROBOT_CODE = os.environ.get("ROBOT_CODE", "scout-001")
ROBOT_SECRET = os.environ.get("ROBOT_SECRET")
LOCATION_CODE = os.environ.get("LOCATION_CODE", "WH1-A03-RB-L04")
EAN = os.environ.get("EAN", "8431234567890")
BOXES = int(os.environ.get("BOXES", "12"))
LOOSE_UNITS = int(os.environ.get("LOOSE_UNITS", "2"))
CONFIDENCE = float(os.environ.get("CONFIDENCE", "0.97"))

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
IMAGE_PATH = os.environ.get("SAMPLE_IMAGE_PATH", os.path.join(SCRIPT_DIR, "sample_image.jpg"))
DB_PATH = os.environ.get("ROBOT_QUEUE_DB", os.path.join(SCRIPT_DIR, "robot_queue.sqlite3"))

REQUEST_TIMEOUT_SECONDS = 15


def log(message: str) -> None:
    print(f"[robot-simulator] {message}")


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS pending_events (
            event_id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            location_code TEXT NOT NULL,
            ean TEXT NOT NULL,
            boxes INTEGER NOT NULL,
            loose_units INTEGER NOT NULL,
            confidence REAL,
            raw_payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            last_error TEXT
        )
        """
    )
    conn.commit()
    conn.row_factory = sqlite3.Row
    return conn


def robot_headers() -> dict:
    if not ROBOT_SECRET:
        log("ERROR: the ROBOT_SECRET environment variable is not set.")
        log(
            "Create or rotate this robot's device secret from the dashboard "
            "(Robots -> select robot -> Rotar secreto) or via the API, then "
            "export ROBOT_SECRET and run this again. The secret is only ever "
            "shown once, at creation/rotation time."
        )
        sys.exit(1)
    return {
        "X-Robot-ID": ROBOT_CODE,
        "Authorization": f"Bearer {ROBOT_SECRET}",
        "Content-Type": "application/json",
    }


class ApiCallError(Exception):
    def __init__(self, status: int, body: dict):
        self.status = status
        self.body = body
        super().__init__(f"HTTP {status}: {body}")


def call_json(method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
    url = f"{BASE_URL}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=robot_headers())
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return resp.status, body
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = {"error": {"message": raw}}
        raise ApiCallError(exc.code, body) from None


def upload_image(upload_url: str, image_bytes: bytes) -> None:
    req = urllib.request.Request(
        upload_url,
        data=image_bytes,
        method="PUT",
        headers={"Content-Type": "image/jpeg"},
    )
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
        if resp.status >= 300:
            raise ApiCallError(resp.status, {"error": {"message": "image upload failed"}})


def capture_and_upload_evidence() -> str:
    """Runs presign -> PUT -> finalize and returns a VERIFIED evidence
    assetId the observation endpoint can reference."""
    with open(IMAGE_PATH, "rb") as f:
        image_bytes = f.read()

    _, presigned = call_json(
        "POST",
        "/api/robot/evidence/presign",
        {"contentType": "image/jpeg", "maxBytes": len(image_bytes)},
    )
    asset_id = presigned["data"]["assetId"]
    upload_url = presigned["data"]["uploadUrl"]

    upload_image(upload_url, image_bytes)

    _, finalized = call_json("POST", "/api/robot/evidence/finalize", {"assetId": asset_id})
    verified_status = finalized["data"]["status"]
    if verified_status != "VERIFIED":
        raise RuntimeError(f"Evidence asset did not verify (status={verified_status}).")

    return asset_id


def send_observation(event: sqlite3.Row) -> tuple[int, dict]:
    evidence_id = capture_and_upload_evidence()
    payload = {
        "eventId": event["event_id"],
        "capturedAt": event["created_at"],
        "locationCode": event["location_code"],
        "ean": event["ean"],
        "boxes": event["boxes"],
        "looseUnits": event["loose_units"],
        "confidence": event["confidence"],
        "evidenceIds": [evidence_id],
        "rawPayload": json.loads(event["raw_payload"]),
    }
    return call_json("POST", "/api/robot/observations", payload)


def report_result(event_id: str, body: dict) -> None:
    data = body["data"]
    if data.get("replay"):
        log(f"Event {event_id}: server recognized this as a replay of an already-processed event (success).")
    else:
        log(f"Event {event_id}: accepted.")
    log(
        f"  Expected: {data.get('expectedQuantity')}  "
        f"Observed: {data.get('observedQuantity')}  "
        f"Difference: {data.get('difference')}  "
        f"Status: {data.get('status')}  "
        f"Confidence: {data.get('confidenceLevel')}"
    )


def process_event(conn: sqlite3.Connection, row: sqlite3.Row) -> None:
    event_id = row["event_id"]
    try:
        _, body = send_observation(row)
        conn.execute(
            "UPDATE pending_events SET status = 'sent', last_error = NULL WHERE event_id = ?",
            (event_id,),
        )
        conn.commit()
        report_result(event_id, body)
    except ApiCallError as exc:
        message = exc.body.get("error", {}).get("message", str(exc))
        if exc.status == 409:
            log(f"Event {event_id}: IDEMPOTENCY CONFLICT — {message}")
            log("  This event id was already used with different data. Not retrying automatically.")
            new_status = "conflict"
        else:
            log(f"Event {event_id}: ERROR ({exc.status}) — {message}")
            new_status = "error"
        conn.execute(
            "UPDATE pending_events SET status = ?, last_error = ? WHERE event_id = ?",
            (new_status, message, event_id),
        )
        conn.commit()
    except Exception as exc:  # noqa: BLE001 - never crash the queue; persist and move on
        log(f"Event {event_id}: ERROR — {exc}")
        conn.execute(
            "UPDATE pending_events SET status = 'error', last_error = ? WHERE event_id = ?",
            (str(exc), event_id),
        )
        conn.commit()


def enqueue_new_event(conn: sqlite3.Connection) -> str:
    event_id = str(uuid.uuid4())
    captured_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    raw_payload = json.dumps({"scanner": "simulator", "camera": "sample-image"})
    conn.execute(
        """
        INSERT INTO pending_events
            (event_id, created_at, location_code, ean, boxes, loose_units, confidence, raw_payload, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        """,
        (event_id, captured_at, LOCATION_CODE, EAN, BOXES, LOOSE_UNITS, CONFIDENCE, raw_payload),
    )
    conn.commit()
    return event_id


def main() -> None:
    log(f"Base URL: {BASE_URL}  Robot: {ROBOT_CODE}  Location: {LOCATION_CODE}  EAN: {EAN}")
    conn = db_connect()

    retryable = conn.execute(
        "SELECT * FROM pending_events WHERE status IN ('pending', 'error') ORDER BY created_at ASC"
    ).fetchall()
    if retryable:
        log(f"Retrying {len(retryable)} unsent event(s) from a previous run before sending anything new...")
        for row in retryable:
            process_event(conn, row)

    new_event_id = enqueue_new_event(conn)
    new_row = conn.execute("SELECT * FROM pending_events WHERE event_id = ?", (new_event_id,)).fetchone()
    process_event(conn, new_row)

    conn.close()


if __name__ == "__main__":
    main()

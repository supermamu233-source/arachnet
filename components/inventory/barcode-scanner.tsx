"use client";

import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { isValidEanChecksum } from "@/domain/products/ean";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface BarcodeScannerProps {
  onDecode: (code: string) => void;
}

/**
 * Scans a barcode with the native BarcodeDetector API when available,
 * falling back to ZXing otherwise. Always offers manual entry alongside the
 * camera, per the product spec ("allow manual entry"). Decodes at most one
 * frame at a time and debounces repeated identical decodes so holding the
 * camera on a code doesn't fire the callback dozens of times.
 */
export function BarcodeScanner({ onDecode }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [manualValue, setManualValue] = useState("");
  const [cameraActive, setCameraActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastDecodedRef = useRef<{ value: string; at: number } | null>(null);
  const decodingRef = useRef(false);

  function reportDecode(rawValue: string) {
    const now = Date.now();
    const last = lastDecodedRef.current;
    // Ignore an identical decode within 1.5s — a camera aimed at a static
    // code otherwise fires the callback on every frame.
    if (last && last.value === rawValue && now - last.at < 1500) return;
    lastDecodedRef.current = { value: rawValue, at: now };

    if (/^\d{8}$|^\d{13}$/.test(rawValue) && !isValidEanChecksum(rawValue)) {
      // Numeric-looking but checksum-invalid — still forward it (it might
      // be a real SKU that happens to be all digits), but never silently
      // "correct" it. The product/location lookup itself is exact-match
      // only, so an invalid code simply won't match anything.
    }
    if (navigator.vibrate) navigator.vibrate(80);
    onDecode(rawValue);
  }

  useEffect(() => {
    if (!cameraActive) return;
    let stopped = false;
    let controls: IScannerControls | undefined;
    let mediaStream: MediaStream | undefined;

    async function start() {
      setError(null);
      try {
        if (typeof window !== "undefined" && "BarcodeDetector" in window) {
          const DetectorCtor = (
            window as unknown as { BarcodeDetector: new (options?: { formats?: string[] }) => {
              detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
            } }
          ).BarcodeDetector;
          const detector = new DetectorCtor({ formats: ["ean_13", "ean_8", "code_128", "upc_a"] });

          mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
          if (stopped) {
            mediaStream.getTracks().forEach((t) => t.stop());
            return;
          }
          if (videoRef.current) {
            videoRef.current.srcObject = mediaStream;
            await videoRef.current.play();
          }

          const tick = async () => {
            if (stopped || !videoRef.current || decodingRef.current) {
              if (!stopped) requestAnimationFrame(tick);
              return;
            }
            decodingRef.current = true;
            try {
              const results = await detector.detect(videoRef.current);
              if (results[0]) reportDecode(results[0].rawValue);
            } catch {
              // Transient decode errors are expected between frames — ignore.
            } finally {
              decodingRef.current = false;
              if (!stopped) requestAnimationFrame(tick);
            }
          };
          requestAnimationFrame(tick);
        } else {
          // ZXing fallback.
          const reader = new BrowserMultiFormatReader();
          controls = await reader.decodeFromVideoDevice(undefined, videoRef.current ?? undefined, (result) => {
            if (result) reportDecode(result.getText());
          });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "No se pudo acceder a la cámara.");
        setCameraActive(false);
      }
    }

    start();

    return () => {
      stopped = true;
      controls?.stop();
      mediaStream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reportDecode/onDecode intentionally excluded: re-running this effect on every render would restart the camera stream.
  }, [cameraActive]);

  return (
    <div className="space-y-3">
      {cameraActive ? (
        <div className="space-y-2">
          <video ref={videoRef} className="aspect-video w-full max-w-sm rounded-md border border-border" muted playsInline />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="button" variant="outline" size="sm" onClick={() => setCameraActive(false)}>
            Detener cámara
          </Button>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setCameraActive(true)}>
          Escanear con cámara
        </Button>
      )}

      <div className="max-w-sm space-y-2">
        <Label htmlFor="manual-code">Entrada manual (EAN o SKU)</Label>
        <div className="flex gap-2">
          <Input
            id="manual-code"
            value={manualValue}
            onChange={(e) => setManualValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && manualValue.trim()) {
                e.preventDefault();
                reportDecode(manualValue.trim());
                setManualValue("");
              }
            }}
          />
          <Button
            type="button"
            onClick={() => {
              if (manualValue.trim()) {
                reportDecode(manualValue.trim());
                setManualValue("");
              }
            }}
          >
            Usar
          </Button>
        </div>
      </div>
    </div>
  );
}

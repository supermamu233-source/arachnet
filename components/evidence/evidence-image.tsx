"use client";

import { useEffect, useState } from "react";

/** Fetches a short-lived signed download URL for a VERIFIED evidence asset
 * and renders it — evidence is never linked directly, only through the
 * authorized signed-URL endpoint (GET /api/evidence/[id]). */
export function EvidenceImage({ assetId, alt }: { assetId: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/evidence/${assetId}`)
      .then((res) => res.json())
      .then((body) => {
        if (cancelled) return;
        if (body.error || !body.data?.url) {
          setFailed(true);
        } else {
          setUrl(body.data.url);
        }
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  if (failed) {
    return <div className="flex h-32 w-32 items-center justify-center rounded-md border border-border text-xs text-muted-foreground">Sin imagen</div>;
  }
  if (!url) {
    return <div className="h-32 w-32 animate-pulse rounded-md bg-muted" />;
  }
  // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL isn't a stable src Next's Image optimizer can cache usefully.
  return <img src={url} alt={alt} className="h-32 w-32 rounded-md border border-border object-cover" />;
}

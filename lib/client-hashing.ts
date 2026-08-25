/**
 * Browser-safe counterpart of lib/hashing.ts::computeRequestHash.
 *
 * lib/hashing.ts uses node:crypto's createHash, which does not exist in
 * browser code — the offline queue (lib/offline-queue.ts) runs entirely in
 * the browser main thread (Dexie/IndexedDB), so it needs an equivalent that
 * only relies on Web-standard APIs. This file reimplements the exact same
 * deterministic algorithm — stable (key-sorted) JSON stringify, then a
 * SHA-256 hex digest — using the Web Crypto API (`crypto.subtle`), which is
 * available in every secure context the offline queue runs in (Next.js only
 * ever serves the app over HTTPS or localhost, both secure contexts).
 *
 * Keep `stableStringify` here in exact lockstep with lib/hashing.ts's
 * version of the same function. The offline queue computes a requestHash
 * client-side, before it ever has a network connection, and that value is
 * sent as-is to the server (see server/services/counts.ts::submitCount,
 * which trusts the caller-supplied requestHash rather than recomputing it)
 * — so the two implementations must be byte-for-byte compatible in what
 * they consider "the same logical payload".
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(",")}}`;
}

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * SHA-256 hex digest of a request payload, computed client-side. Used by
 * the offline queue to derive the `requestHash` it submits alongside its
 * client-generated `idempotencyKey` — see the module docstring above for
 * why the server trusts this value rather than recomputing it.
 */
export async function computeRequestHash(payload: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(stableStringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return bytesToHex(digest);
}

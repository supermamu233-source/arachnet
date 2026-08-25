/**
 * Storage-agnostic interface for the private evidence object store. The only
 * implementation today is the S3-compatible one in `s3-storage.ts` (MinIO
 * locally, Cloudflare R2 in production), but routes/services should depend on
 * this interface, not on `@aws-sdk/*` directly, so the backing store can
 * change without touching call sites.
 *
 * Every object handled through this interface is expected to live in a
 * PRIVATE bucket. There is deliberately no "public URL" method here — reads
 * only ever happen through {@link ObjectStorage.presignGet}, which issues a
 * short-lived signed URL.
 */
export interface ObjectStorage {
  /** Issues a short-lived presigned PUT URL for a client to upload directly
   * to. A plain S3 presigned PUT (unlike a presigned POST policy) cannot
   * enforce a byte-size condition at the signature level, so `maxBytes` is
   * recorded by the caller for later enforcement — callers MUST re-verify
   * actual size server-side after upload (see `finalizeEvidence`) since the
   * presigned URL alone cannot be trusted to cap the payload. */
  presignPut(key: string, contentType: string, maxBytes: number): Promise<{ url: string; key: string }>;

  /** Returns size/content-type metadata for an object, or null if it does not
   * exist (e.g. the client never actually completed the PUT). */
  headObject(key: string): Promise<{ contentLength: number; contentType: string } | null>;

  /** Downloads an object's full contents. Used server-side only, to hash and
   * decode evidence bytes before marking them verified — never exposed
   * directly to a client. */
  getObjectBuffer(key: string): Promise<Buffer>;

  /** Uploads a buffer server-side, used for derived DISPLAY/THUMB image
   * variants produced during finalization. */
  putObjectBuffer(key: string, body: Buffer, contentType: string): Promise<void>;

  /** Issues a short-lived signed GET URL for an object, valid for
   * `expiresInSeconds` seconds. This is the only sanctioned way to read
   * evidence bytes from outside this server. */
  presignGet(key: string, expiresInSeconds: number): Promise<string>;

  /** Permanently deletes an object from the backing store. */
  deleteObject(key: string): Promise<void>;
}

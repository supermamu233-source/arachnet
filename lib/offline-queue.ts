import Dexie, { type Table } from "dexie";
import { computeRequestHash } from "@/lib/client-hashing";

/**
 * Browser-only offline queue for physical counts (product spec section on
 * offline-first counting). Backed by Dexie/IndexedDB so queued records —
 * including locally-captured photo blobs — survive a browser restart with
 * no extra persistence code: IndexedDB just has them the next time this
 * module runs in the same origin.
 *
 * Queue state machine (spec-mandated names):
 *   DRAFT            — created locally, not yet attempted.
 *   PENDING          — claimed by a sync pass, about to start work on it.
 *   UPLOADING        — actively uploading photos and/or submitting the count.
 *   COMMITTED        — the server has confirmed the count. Terminal.
 *   FAILED_RETRYABLE — a transient failure (network error, 5xx, 429).
 *                       Will be retried automatically with backoff.
 *   FAILED_PERMANENT — a definitive rejection (422, 404, 409 idempotency
 *                       conflict). Needs a human to look at it. Terminal
 *                       unless a human explicitly requests a retry.
 */

export type QueuedCountState =
  | "DRAFT"
  | "PENDING"
  | "UPLOADING"
  | "COMMITTED"
  | "FAILED_RETRYABLE"
  | "FAILED_PERMANENT";

export type QueuedPhotoContentType = "image/jpeg" | "image/png" | "image/webp";

export interface QueuedPhoto {
  /** Local id, independent of any server-side evidence asset id. */
  id: string;
  contentType: QueuedPhotoContentType;
  /** The local blob, kept until the server has confirmed the count is
   * COMMITTED — never deleted before that (per the spec requirement "do not
   * delete a local record until the server confirms commit"). Cleared
   * (set to undefined) only after commit, to stop the local IndexedDB
   * store from growing without bound once a photo is no longer needed. */
  blob?: Blob;
  /** The VERIFIED EvidenceAsset id, once this photo has been uploaded
   * through the presign -> PUT -> finalize flow. */
  assetId?: string;
}

export interface QueuedCount {
  /** Local primary key. */
  id: string;
  /** Generated with crypto.randomUUID() at DRAFT-creation time, before any
   * network call — per the spec requirement to generate the idempotency
   * key up front, so even the very first sync attempt (whenever it
   * eventually happens) already carries a stable key. */
  idempotencyKey: string;
  state: QueuedCountState;
  warehouseId: string;
  sessionId?: string;
  productId: string;
  locationId: string;
  boxes: number;
  looseUnits: number;
  observation?: string;
  /** ISO 8601 string — when the count was physically taken, not when it
   * was queued or synced. */
  capturedAt: string;
  photos: QueuedPhoto[];
  retryCount: number;
  lastError?: string;
  /** Epoch ms; a FAILED_RETRYABLE record is not picked up again until this
   * has passed (exponential backoff). */
  nextRetryAt?: number;
  /** Populated once the server has confirmed the commit. */
  serverCountId?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Maximum number of "active" queued records — see {@link isActiveState} for
 * exactly what counts. Enforced at creation time; adding a 251st active
 * record is rejected outright with a {@link QueueFullError} the UI can show
 * to the counter (e.g. "sync now, or clean up failed records, before
 * queuing more counts").
 */
export const MAX_ACTIVE_QUEUED_COUNTS = 250;

/**
 * A record is "active" — and counts against the 250 cap — unless it has
 * reached a state the sync engine no longer needs to act on:
 *  - COMMITTED: done, nothing left to do.
 *  - FAILED_PERMANENT: needs a human to inspect/discard it, but is no
 *    longer competing for sync attempts or automatically growing local
 *    storage through retries.
 * Every other state (DRAFT, PENDING, UPLOADING, FAILED_RETRYABLE) is live
 * work the queue is still responsible for, and counts toward the cap.
 */
function isActiveState(state: QueuedCountState): boolean {
  return state !== "COMMITTED" && state !== "FAILED_PERMANENT";
}

export class QueueFullError extends Error {
  constructor() {
    super(
      `No se puede guardar el conteo: ya hay ${MAX_ACTIVE_QUEUED_COUNTS} conteos activos en la cola sin sincronizar. Sincroniza o revisa los conteos fallidos antes de continuar.`,
    );
    this.name = "QueueFullError";
  }
}

class OfflineQueueDatabase extends Dexie {
  queuedCounts!: Table<QueuedCount, string>;

  constructor() {
    super("arachnet-offline-queue");
    this.version(1).stores({
      // `&idempotencyKey` enforces uniqueness at the IndexedDB level too,
      // mirroring InventoryCount.idempotencyKey's unique column server-side
      // — belt and braces, since these are randomUUID()s a collision should
      // never actually happen.
      queuedCounts: "id, state, &idempotencyKey, createdAt, nextRetryAt",
    });
  }
}

let dbInstance: OfflineQueueDatabase | null = null;

function getDb(): OfflineQueueDatabase {
  // Guard on `indexedDB` rather than `window` so this also works under
  // Vitest's Node environment with fake-indexeddb (which polyfills the
  // global `indexedDB`/`IDBKeyRange` but not `window`) — see
  // tests/unit/offline-queue.test.ts.
  if (typeof indexedDB === "undefined") {
    throw new Error(
      "lib/offline-queue is browser-only and requires IndexedDB (or a test environment with fake-indexeddb).",
    );
  }
  if (!dbInstance) {
    dbInstance = new OfflineQueueDatabase();
  }
  return dbInstance;
}

/** Test-only escape hatch: wipes every queued record so each test starts
 * from a clean slate. Never call this from application code. */
export async function __clearOfflineQueueForTests(): Promise<void> {
  await getDb().queuedCounts.clear();
}

export interface NewQueuedCountPhotoInput {
  blob: Blob;
  contentType: QueuedPhotoContentType;
}

export interface NewQueuedCountInput {
  warehouseId: string;
  sessionId?: string;
  productId: string;
  locationId: string;
  boxes: number;
  looseUnits: number;
  observation?: string;
  capturedAt: string;
  photos: NewQueuedCountPhotoInput[];
}

/**
 * Creates a new DRAFT queued count — the "save offline" step of the count
 * workflow. Must be called with everything already captured (location,
 * product, quantities, photos) since a draft is immediately eligible for
 * sync. Rejects with {@link QueueFullError} if the 250-active-record cap
 * would be exceeded.
 */
export async function createDraftCount(input: NewQueuedCountInput): Promise<QueuedCount> {
  const db = getDb();

  const activeCount = await db.queuedCounts.filter((record) => isActiveState(record.state)).count();
  if (activeCount >= MAX_ACTIVE_QUEUED_COUNTS) {
    throw new QueueFullError();
  }

  const now = Date.now();
  const record: QueuedCount = {
    id: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    state: "DRAFT",
    warehouseId: input.warehouseId,
    sessionId: input.sessionId,
    productId: input.productId,
    locationId: input.locationId,
    boxes: input.boxes,
    looseUnits: input.looseUnits,
    observation: input.observation,
    capturedAt: input.capturedAt,
    photos: input.photos.map((photo) => ({
      id: crypto.randomUUID(),
      contentType: photo.contentType,
      blob: photo.blob,
    })),
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  await db.queuedCounts.add(record);
  return record;
}

export async function listQueuedCounts(): Promise<QueuedCount[]> {
  return getDb().queuedCounts.orderBy("createdAt").reverse().toArray();
}

export async function getQueuedCount(id: string): Promise<QueuedCount | undefined> {
  return getDb().queuedCounts.get(id);
}

/** Small per-state tally for the "pending / uploading / committed / failed"
 * status summary the count workflow UI shows. */
export async function getQueueStatusCounts(): Promise<Record<QueuedCountState, number>> {
  const all = await getDb().queuedCounts.toArray();
  const summary: Record<QueuedCountState, number> = {
    DRAFT: 0,
    PENDING: 0,
    UPLOADING: 0,
    COMMITTED: 0,
    FAILED_RETRYABLE: 0,
    FAILED_PERMANENT: 0,
  };
  for (const record of all) summary[record.state]++;
  return summary;
}

/**
 * Manually requeues a failed record (retryable OR permanent — a human
 * looking at a FAILED_PERMANENT record and choosing "retry anyway" is a
 * deliberate override) for the next sync pass, clearing its backoff timer.
 * No-op if the record doesn't exist or isn't in a failed state.
 */
export async function retryQueuedCount(id: string): Promise<void> {
  const db = getDb();
  const record = await db.queuedCounts.get(id);
  if (!record) return;
  if (record.state !== "FAILED_RETRYABLE" && record.state !== "FAILED_PERMANENT") return;

  await db.queuedCounts.update(id, {
    state: "DRAFT",
    nextRetryAt: undefined,
    updatedAt: Date.now(),
  });
}

/** Deletes a queued record. Only ever call this for a COMMITTED record (the
 * server has confirmed it, so nothing is lost) or a FAILED_PERMANENT one a
 * human has explicitly decided to discard — never for anything still live,
 * per the "do not delete a local record until the server confirms commit"
 * requirement. */
export async function deleteQueuedCount(id: string): Promise<void> {
  await getDb().queuedCounts.delete(id);
}

// ---------------------------------------------------------------------------
// Sync engine
// ---------------------------------------------------------------------------

type FetchLike = typeof fetch;

interface ApiEnvelope<T> {
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
  requestId: string;
}

/** Thrown for any non-2xx HTTP response encountered while syncing a
 * record, carrying enough information (status + the server's error code,
 * when present) to classify the failure as retryable or permanent. */
class SyncHttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "SyncHttpError";
    this.status = status;
    this.code = code;
  }
}

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

function computeBackoffMs(retryCount: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** retryCount, MAX_BACKOFF_MS);
}

/**
 * Classifies a caught error/exception as retryable or a definitive,
 * permanent failure:
 *  - No HTTP status at all (a thrown TypeError from `fetch` itself, e.g.
 *    genuinely offline, DNS failure, aborted request) is always retryable
 *    — the request never even reached the server.
 *  - 429 (rate limited) and any 5xx are retryable.
 *  - A 409 IDEMPOTENCY_CONFLICT is treated as permanent — per the spec,
 *    this should not normally happen for a client-generated key used once,
 *    but if it does the record needs a human, not an infinite retry loop.
 *  - Every other 4xx (422 VALIDATION_ERROR, 404 PRODUCT_NOT_FOUND /
 *    LOCATION_NOT_FOUND, etc.) is a definitive rejection — permanent.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof SyncHttpError) {
    if (error.code === "IDEMPOTENCY_CONFLICT") return false;
    if (error.status === 429) return true;
    return error.status >= 500;
  }
  return true;
}

async function parseEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  try {
    return (await response.json()) as ApiEnvelope<T>;
  } catch {
    return { data: null, error: null, requestId: "" };
  }
}

async function presignEvidenceUpload(
  fetchImpl: FetchLike,
  contentType: QueuedPhotoContentType,
): Promise<{ uploadUrl: string; assetId: string }> {
  const response = await fetchImpl("/api/evidence/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purpose: "COUNT_IMAGE", contentType }),
  });
  const body = await parseEnvelope<{ uploadUrl: string; assetId: string; objectKey: string }>(response);
  if (!response.ok || !body.data) {
    throw new SyncHttpError(
      response.status,
      body.error?.code,
      body.error?.message ?? "No se pudo iniciar la subida de la fotografía.",
    );
  }
  return { uploadUrl: body.data.uploadUrl, assetId: body.data.assetId };
}

async function uploadPhotoBlob(
  fetchImpl: FetchLike,
  uploadUrl: string,
  blob: Blob,
  contentType: QueuedPhotoContentType,
): Promise<void> {
  const response = await fetchImpl(uploadUrl, {
    method: "PUT",
    body: blob,
    headers: { "Content-Type": contentType },
  });
  if (!response.ok) {
    throw new SyncHttpError(response.status, undefined, `La subida de la fotografía falló (HTTP ${response.status}).`);
  }
}

async function finalizeEvidenceAsset(fetchImpl: FetchLike, assetId: string): Promise<void> {
  const response = await fetchImpl("/api/evidence/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assetId }),
  });
  const body = await parseEnvelope<unknown>(response);
  if (!response.ok) {
    throw new SyncHttpError(
      response.status,
      body.error?.code,
      body.error?.message ?? "No se pudo finalizar la fotografía.",
    );
  }
}

/** The exact fields that determine "the same logical count submission" for
 * this queued record's requestHash. Deliberately excludes idempotencyKey
 * itself (that's the lookup key, not part of what's being compared) and any
 * locally-assigned id/timestamps that don't describe the count's content.
 * evidenceAssetIds is sorted so upload order never changes the hash. */
function buildRequestHashPayload(record: QueuedCount, evidenceAssetIds: string[]) {
  return {
    sessionId: record.sessionId ?? null,
    productId: record.productId,
    locationId: record.locationId,
    boxes: record.boxes,
    looseUnits: record.looseUnits,
    observation: record.observation ?? null,
    evidenceAssetIds: [...evidenceAssetIds].sort(),
    capturedAt: record.capturedAt,
  };
}

async function markFailed(db: OfflineQueueDatabase, recordId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : "Error desconocido durante la sincronización.";
  const current = await db.queuedCounts.get(recordId);
  const retryCount = (current?.retryCount ?? 0) + 1;

  if (isRetryable(error)) {
    await db.queuedCounts.update(recordId, {
      state: "FAILED_RETRYABLE",
      retryCount,
      lastError: message,
      nextRetryAt: Date.now() + computeBackoffMs(retryCount),
      updatedAt: Date.now(),
    });
  } else {
    await db.queuedCounts.update(recordId, {
      state: "FAILED_PERMANENT",
      retryCount,
      lastError: message,
      nextRetryAt: undefined,
      updatedAt: Date.now(),
    });
  }
}

/**
 * Processes one queued record: uploads any not-yet-uploaded photos through
 * the presign -> PUT -> finalize evidence flow, then submits the count
 * itself. Transitions the record through PENDING -> UPLOADING ->
 * COMMITTED on success, or to FAILED_RETRYABLE / FAILED_PERMANENT on
 * failure (see {@link isRetryable}). Never deletes the record and never
 * clears its local photo blobs before COMMITTED is reached.
 */
async function processQueuedCount(db: OfflineQueueDatabase, record: QueuedCount, fetchImpl: FetchLike): Promise<void> {
  await db.queuedCounts.update(record.id, { state: "PENDING", updatedAt: Date.now() });

  try {
    // UPLOADING covers both phases of network work this record still needs:
    // any not-yet-uploaded photos, and then the count submission itself.
    await db.queuedCounts.update(record.id, { state: "UPLOADING", updatedAt: Date.now() });

    const photos = record.photos.map((photo) => ({ ...photo }));

    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      if (photo.assetId || !photo.blob) continue;

      const { uploadUrl, assetId } = await presignEvidenceUpload(fetchImpl, photo.contentType);
      await uploadPhotoBlob(fetchImpl, uploadUrl, photo.blob, photo.contentType);
      await finalizeEvidenceAsset(fetchImpl, assetId);

      photos[i] = { ...photo, assetId };
      await db.queuedCounts.update(record.id, { photos, updatedAt: Date.now() });
    }

    const evidenceAssetIds = photos.map((photo) => photo.assetId).filter((id): id is string => Boolean(id));
    const requestHash = await computeRequestHash(buildRequestHashPayload(record, evidenceAssetIds));

    const response = await fetchImpl("/api/counts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        warehouseId: record.warehouseId,
        sessionId: record.sessionId,
        productId: record.productId,
        locationId: record.locationId,
        boxes: record.boxes,
        looseUnits: record.looseUnits,
        observation: record.observation,
        evidenceAssetIds,
        capturedAt: record.capturedAt,
        idempotencyKey: record.idempotencyKey,
        requestHash,
      }),
    });
    const body = await parseEnvelope<{ id: string }>(response);

    if (!response.ok || !body.data) {
      throw new SyncHttpError(
        response.status,
        body.error?.code,
        body.error?.message ?? "No se pudo guardar el conteo.",
      );
    }

    // Only now — after the server has confirmed the commit — do we free the
    // local blob storage. The record itself is kept (as a COMMITTED history
    // entry the UI can still show), just without the now-redundant blobs.
    const clearedPhotos = photos.map((photo) => ({ ...photo, blob: undefined }));
    await db.queuedCounts.update(record.id, {
      state: "COMMITTED",
      serverCountId: body.data.id,
      photos: clearedPhotos,
      lastError: undefined,
      nextRetryAt: undefined,
      updatedAt: Date.now(),
    });
  } catch (error) {
    await markFailed(db, record.id, error);
  }
}

export interface SyncOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

export interface SyncRunSummary {
  attempted: number;
  committed: number;
  failedRetryable: number;
  failedPermanent: number;
}

/**
 * Runs one sync pass over every eligible queued record (DRAFT, or
 * FAILED_RETRYABLE whose backoff has elapsed), sequentially. Safe to call
 * on page load (picks up whatever survived a browser restart, per
 * IndexedDB's normal persistence — no extra bookkeeping needed for that),
 * on an `online` event, on an interval, or from a manual "sync now" button
 * — the caller decides when/how often to invoke it; this function itself
 * has no side effects beyond one pass over what's currently eligible.
 */
export async function syncQueuedCounts(options: SyncOptions = {}): Promise<SyncRunSummary> {
  const db = getDb();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = Date.now();

  const candidates = await db.queuedCounts.where("state").anyOf(["DRAFT", "FAILED_RETRYABLE"]).toArray();
  const eligible = candidates.filter(
    (record) => record.state === "DRAFT" || !record.nextRetryAt || record.nextRetryAt <= now,
  );

  const summary: SyncRunSummary = { attempted: 0, committed: 0, failedRetryable: 0, failedPermanent: 0 };

  // Sequential rather than parallel: keeps behavior easy to reason about
  // and test deterministically, and avoids bursting many concurrent
  // evidence uploads over what may be a weak connection.
  for (const record of eligible) {
    summary.attempted++;
    await processQueuedCount(db, record, fetchImpl);
    const updated = await db.queuedCounts.get(record.id);
    if (updated?.state === "COMMITTED") summary.committed++;
    else if (updated?.state === "FAILED_RETRYABLE") summary.failedRetryable++;
    else if (updated?.state === "FAILED_PERMANENT") summary.failedPermanent++;
  }

  return summary;
}

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearOfflineQueueForTests,
  createDraftCount,
  getQueueStatusCounts,
  listQueuedCounts,
  MAX_ACTIVE_QUEUED_COUNTS,
  QueueFullError,
  syncQueuedCounts,
  type NewQueuedCountInput,
} from "@/lib/offline-queue";

function makeInput(overrides: Partial<NewQueuedCountInput> = {}): NewQueuedCountInput {
  return {
    warehouseId: "wh-1",
    productId: "prod-1",
    locationId: "loc-1",
    boxes: 2,
    looseUnits: 3,
    capturedAt: new Date().toISOString(),
    photos: [{ blob: new Blob(["fake-image-bytes"], { type: "image/jpeg" }), contentType: "image/jpeg" }],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(async () => {
  await __clearOfflineQueueForTests();
});

describe("offline queue: creating records", () => {
  it("generates an idempotency key up front, before any network call, and starts in DRAFT", async () => {
    const record = await createDraftCount(makeInput());

    expect(record.idempotencyKey).toBeTruthy();
    expect(record.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(record.state).toBe("DRAFT");

    const stored = await listQueuedCounts();
    expect(stored).toHaveLength(1);
    expect(stored[0].idempotencyKey).toBe(record.idempotencyKey);
  });

  it("enforces the 250 active-record cap and rejects a 251st", async () => {
    for (let i = 0; i < MAX_ACTIVE_QUEUED_COUNTS; i++) {
      await createDraftCount(makeInput({ photos: [] }));
    }

    const summary = await getQueueStatusCounts();
    expect(summary.DRAFT).toBe(MAX_ACTIVE_QUEUED_COUNTS);

    await expect(createDraftCount(makeInput({ photos: [] }))).rejects.toThrow(QueueFullError);

    // Still exactly the cap — the rejected attempt was never persisted.
    const all = await listQueuedCounts();
    expect(all).toHaveLength(MAX_ACTIVE_QUEUED_COUNTS);
  }, 30_000);

  it("does not count COMMITTED records against the active cap", async () => {
    // Commit exactly one record first (via the real sync path), before any
    // other records exist — syncQueuedCounts processes every eligible
    // DRAFT/FAILED_RETRYABLE record it finds, so committing "just one" only
    // works cleanly when it's the only eligible record at sync time.
    await createDraftCount(makeInput({ photos: [] }));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href === "/api/counts") {
        return jsonResponse({ data: { id: "count-1" }, error: null, requestId: "r" }, 201);
      }
      throw new Error(`Unexpected fetch to ${href}`);
    });
    await syncQueuedCounts({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await getQueueStatusCounts()).COMMITTED).toBe(1);

    // Now fill the cap with fresh DRAFT records — since the committed one
    // no longer counts as "active," all MAX_ACTIVE_QUEUED_COUNTS of these
    // should succeed.
    for (let i = 0; i < MAX_ACTIVE_QUEUED_COUNTS; i++) {
      await createDraftCount(makeInput({ photos: [] }));
    }
    const summary = await getQueueStatusCounts();
    expect(summary.COMMITTED).toBe(1);
    expect(summary.DRAFT).toBe(MAX_ACTIVE_QUEUED_COUNTS);

    // The cap is still enforced — a 251st active record is rejected.
    await expect(createDraftCount(makeInput({ photos: [] }))).rejects.toThrow(QueueFullError);
  }, 30_000);
});

describe("offline queue: sync state transitions", () => {
  it("moves a record through PENDING -> UPLOADING -> COMMITTED in order, uploads evidence, and clears blobs only after commit", async () => {
    const record = await createDraftCount(makeInput());
    const observedStates: string[] = [];

    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url.toString();

      // Snapshot the record's state at the moment each network call is
      // made, so we can assert the transitions happened in order.
      const current = (await listQueuedCounts()).find((r) => r.id === record.id);
      if (current) observedStates.push(current.state);

      if (href === "/api/evidence/presign") {
        return jsonResponse(
          { data: { uploadUrl: "https://upload.example/put-target", assetId: "asset-1", objectKey: "k" }, error: null, requestId: "r1" },
          201,
        );
      }
      if (href === "https://upload.example/put-target") {
        return new Response(null, { status: 200 });
      }
      if (href === "/api/evidence/finalize") {
        return jsonResponse({ data: { id: "asset-1", status: "VERIFIED" }, error: null, requestId: "r2" }, 200);
      }
      if (href === "/api/counts") {
        return jsonResponse({ data: { id: "count-1", physicalQuantity: 9 }, error: null, requestId: "r3" }, 201);
      }
      throw new Error(`Unexpected fetch to ${href}`);
      void init;
    });

    const summary = await syncQueuedCounts({ fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(summary.committed).toBe(1);
    expect(summary.failedRetryable).toBe(0);
    expect(summary.failedPermanent).toBe(0);

    // PENDING is set before any fetch call fires, so the first observed
    // state at the first fetch call (presign) should already be past
    // PENDING (UPLOADING) — and every state we did observe must be in the
    // order the state machine allows, never regressing.
    const rank: Record<string, number> = { DRAFT: 0, PENDING: 1, UPLOADING: 2, COMMITTED: 3 };
    for (let i = 1; i < observedStates.length; i++) {
      expect(rank[observedStates[i]]).toBeGreaterThanOrEqual(rank[observedStates[i - 1]]);
    }

    const all = await listQueuedCounts();
    expect(all).toHaveLength(1);
    expect(all[0].state).toBe("COMMITTED");
    expect(all[0].serverCountId).toBe("count-1");
    // The record itself is never deleted before COMMITTED — and it's still
    // present now, just with its local blob freed.
    expect(all[0].photos).toHaveLength(1);
    expect(all[0].photos[0].blob).toBeUndefined();
    expect(all[0].photos[0].assetId).toBe("asset-1");
  });

  it("never deletes a record while it is still DRAFT/PENDING/UPLOADING/FAILED_RETRYABLE, even across a failed sync attempt", async () => {
    await createDraftCount(makeInput({ photos: [] }));

    const fetchImpl = vi.fn(async () => new Response(null, { status: 0 })); // simulate a network failure shape

    // Force a thrown network error instead, which is the realistic offline case.
    fetchImpl.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });

    await syncQueuedCounts({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const all = await listQueuedCounts();
    expect(all).toHaveLength(1);
    expect(all[0].state).toBe("FAILED_RETRYABLE");
  });

  it("marks a record FAILED_RETRYABLE on a 500 and schedules a future retry", async () => {
    await createDraftCount(makeInput({ photos: [] }));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href === "/api/counts") {
        return jsonResponse({ data: null, error: { code: "INTERNAL_ERROR", message: "boom" }, requestId: "r" }, 500);
      }
      throw new Error(`Unexpected fetch to ${href}`);
    });

    const summary = await syncQueuedCounts({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(summary.failedRetryable).toBe(1);

    const all = await listQueuedCounts();
    expect(all[0].state).toBe("FAILED_RETRYABLE");
    expect(all[0].retryCount).toBe(1);
    expect(all[0].nextRetryAt).toBeGreaterThan(Date.now());

    // Not eligible again immediately — nextRetryAt is in the future.
    const secondPass = await syncQueuedCounts({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(secondPass.attempted).toBe(0);
  });

  it("marks a record FAILED_PERMANENT on a definitive 422 validation error", async () => {
    await createDraftCount(makeInput({ photos: [] }));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href === "/api/counts") {
        return jsonResponse({ data: null, error: { code: "VALIDATION_ERROR", message: "bad payload" }, requestId: "r" }, 422);
      }
      throw new Error(`Unexpected fetch to ${href}`);
    });

    const summary = await syncQueuedCounts({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(summary.failedPermanent).toBe(1);

    const all = await listQueuedCounts();
    expect(all[0].state).toBe("FAILED_PERMANENT");

    // A permanent failure is not retried automatically.
    const secondPass = await syncQueuedCounts({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(secondPass.attempted).toBe(0);
  });

  it("marks a record FAILED_PERMANENT on a 409 idempotency conflict", async () => {
    await createDraftCount(makeInput({ photos: [] }));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href === "/api/counts") {
        return jsonResponse(
          { data: null, error: { code: "IDEMPOTENCY_CONFLICT", message: "reused key" }, requestId: "r" },
          409,
        );
      }
      throw new Error(`Unexpected fetch to ${href}`);
    });

    const summary = await syncQueuedCounts({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(summary.failedPermanent).toBe(1);
    expect((await listQueuedCounts())[0].state).toBe("FAILED_PERMANENT");
  });
});

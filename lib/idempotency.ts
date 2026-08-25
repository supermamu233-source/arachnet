import { ApiError } from "@/lib/errors";

/**
 * Resolves an idempotency-key lookup against a freshly computed request hash.
 *
 * Call this after looking up any existing row by its unique idempotency key
 * (InventoryCount.idempotencyKey, ProductIntake.idempotencyKey,
 * ImportJob/ExportJob.idempotencyKey, or RobotObservation's [robotId, eventId]
 * unique key). Same key + same hash is a safe retry — return the original
 * result. Same key + different hash means the client reused a key for a
 * different request, which must fail loudly rather than silently overwrite
 * the original.
 */
export function resolveIdempotency<T extends { requestHash: string }>(
  existing: T | null,
  requestHash: string,
): { outcome: "new" } | { outcome: "replay"; record: T } {
  if (!existing) return { outcome: "new" };

  if (existing.requestHash !== requestHash) {
    throw new ApiError(
      "IDEMPOTENCY_CONFLICT",
      "This idempotency key was already used with a different request payload.",
    );
  }

  return { outcome: "replay", record: existing };
}

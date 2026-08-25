import type { ConfidenceLevel } from "@/domain/reconciliation/confidence";

export type DiscrepancyStatus =
  | "MATCH"
  | "SHORTAGE"
  | "SURPLUS"
  | "EXPECTED_MISSING"
  | "PHYSICAL_UNVERIFIED"
  | "REVIEW_REQUIRED"
  | "RESOLVED"
  | "DISMISSED";

interface ClassifyStatusInput {
  expectedQuantity: number | null;
  observedQuantity: number | null;
  confidenceLevel?: ConfidenceLevel;
}

/**
 * Computes the reconciliation status for one product-location pair, given
 * the current authoritative expected balance and the latest accepted
 * physical observation. Never invoked with a location-level count against a
 * product-wide expected total — both quantities must already be scoped to
 * the same product AND location (product principle 3.7).
 *
 * RESOLVED and DISMISSED are terminal states applied by the resolution
 * workflow (server/services/reconciliation.ts), not derived here.
 */
export function classifyDiscrepancyStatus(input: ClassifyStatusInput): DiscrepancyStatus {
  if (input.expectedQuantity == null) return "EXPECTED_MISSING";
  if (input.observedQuantity == null) return "PHYSICAL_UNVERIFIED";

  // A low-confidence or evidence-incomplete observation can never
  // auto-resolve to MATCH/SHORTAGE/SURPLUS — a human must review it first
  // (product principle 2.2/2.8).
  if (input.confidenceLevel === "REVIEW_REQUIRED") return "REVIEW_REQUIRED";

  if (input.observedQuantity === input.expectedQuantity) return "MATCH";
  return input.observedQuantity > input.expectedQuantity ? "SURPLUS" : "SHORTAGE";
}

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW" | "REVIEW_REQUIRED";

export interface ConfidenceThresholds {
  high: number;
  medium: number;
  low: number;
}

/** Operational thresholds only — not a statistical accuracy claim (product
 * principle 2.8: "no fake certainty"). Configurable per organization/robot,
 * these are just sensible starting defaults. */
export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = {
  high: 0.9,
  medium: 0.75,
  low: 0.5,
};

/**
 * Classifies a robot (or other machine) observation's confidence
 * deterministically. An observation with no raw confidence, or with
 * incomplete evidence (e.g. missing an image), can never be classified above
 * REVIEW_REQUIRED — a human must look at it before it can correct an
 * external system (principle 2.2/2.8).
 */
export function classifyConfidence(
  rawConfidence: number | null | undefined,
  hasCompleteEvidence: boolean,
  thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS,
): ConfidenceLevel {
  if (rawConfidence == null || !hasCompleteEvidence) return "REVIEW_REQUIRED";
  if (rawConfidence >= thresholds.high) return "HIGH";
  if (rawConfidence >= thresholds.medium) return "MEDIUM";
  if (rawConfidence >= thresholds.low) return "LOW";
  return "REVIEW_REQUIRED";
}

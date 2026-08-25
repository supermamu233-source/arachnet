export type DiscrepancySeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

interface SeverityBand {
  minAbsolute: number;
  minPercentage: number;
}

export interface SeverityThresholds {
  medium: SeverityBand;
  high: SeverityBand;
  critical: SeverityBand;
}

/**
 * Default operational thresholds from product spec section 13. These are
 * deliberately configurable (per organization) and documented as operational
 * triage bands, not a statistical accuracy claim.
 */
export const DEFAULT_SEVERITY_THRESHOLDS: SeverityThresholds = {
  medium: { minAbsolute: 5, minPercentage: 0.1 },
  high: { minAbsolute: 20, minPercentage: 0.25 },
  critical: { minAbsolute: 50, minPercentage: 0.5 },
};

/**
 * Classifies the severity of an expected-vs-observed difference. Severity is
 * driven by whichever is more sensitive for a given expected quantity: a
 * fixed absolute-unit threshold, or a percentage-of-expected threshold.
 * `expectedQuantity` of 0 is treated as "any nonzero difference is
 * percentage-infinite", relying on the absolute threshold instead.
 */
export function classifySeverity(
  difference: number,
  expectedQuantity: number,
  thresholds: SeverityThresholds = DEFAULT_SEVERITY_THRESHOLDS,
): DiscrepancySeverity {
  const absoluteDifference = Math.abs(difference);
  const percentageDifference = expectedQuantity > 0 ? absoluteDifference / expectedQuantity : Infinity;

  const exceeds = (band: SeverityBand) =>
    absoluteDifference >= band.minAbsolute || percentageDifference >= band.minPercentage;

  if (exceeds(thresholds.critical)) return "CRITICAL";
  if (exceeds(thresholds.high)) return "HIGH";
  if (exceeds(thresholds.medium)) return "MEDIUM";
  return "LOW";
}

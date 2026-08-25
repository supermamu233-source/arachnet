import { describe, expect, it } from "vitest";
import { classifyConfidence } from "@/domain/reconciliation/confidence";
import { classifySeverity } from "@/domain/reconciliation/severity";
import { classifyDiscrepancyStatus } from "@/domain/reconciliation/status";

describe("classifyConfidence", () => {
  it("classifies HIGH above the high threshold with complete evidence", () => {
    expect(classifyConfidence(0.97, true)).toBe("HIGH");
  });

  it("classifies MEDIUM between medium and high", () => {
    expect(classifyConfidence(0.8, true)).toBe("MEDIUM");
  });

  it("classifies LOW between low and medium", () => {
    expect(classifyConfidence(0.6, true)).toBe("LOW");
  });

  it("classifies REVIEW_REQUIRED below the low threshold", () => {
    expect(classifyConfidence(0.2, true)).toBe("REVIEW_REQUIRED");
  });

  it("classifies REVIEW_REQUIRED when confidence is missing, regardless of the number", () => {
    expect(classifyConfidence(null, true)).toBe("REVIEW_REQUIRED");
    expect(classifyConfidence(undefined, true)).toBe("REVIEW_REQUIRED");
  });

  it("classifies REVIEW_REQUIRED when evidence is incomplete even at high raw confidence", () => {
    expect(classifyConfidence(0.99, false)).toBe("REVIEW_REQUIRED");
  });
});

describe("classifySeverity", () => {
  it("classifies LOW for a small difference", () => {
    expect(classifySeverity(1, 100)).toBe("LOW");
  });

  it("classifies MEDIUM at the absolute threshold", () => {
    expect(classifySeverity(5, 1000)).toBe("MEDIUM");
  });

  it("classifies MEDIUM at the percentage threshold", () => {
    expect(classifySeverity(2, 20)).toBe("MEDIUM"); // 10% of 20
  });

  it("classifies HIGH at >= 20 units or >= 25%", () => {
    expect(classifySeverity(20, 1000)).toBe("HIGH");
    expect(classifySeverity(3, 10)).toBe("HIGH"); // 30% of 10
  });

  it("classifies CRITICAL at >= 50 units or >= 50%", () => {
    expect(classifySeverity(50, 1000)).toBe("CRITICAL");
    expect(classifySeverity(6, 10)).toBe("CRITICAL"); // 60% of 10
  });

  it("matches the required robot-integration seed case (-8 vs expected 82 => MEDIUM)", () => {
    // abs=8 already meets the medium absolute threshold (>=5 units), even
    // though the percentage (8/82 ≈ 9.8%) is just under the 10% band.
    expect(classifySeverity(-8, 82)).toBe("MEDIUM");
  });

  it("treats any nonzero difference as maximally severe when nothing was expected", () => {
    // expectedQuantity=0 makes the percentage term Infinity, so even a small
    // absolute difference is CRITICAL — finding stock where none should
    // exist (or vice versa) is inherently surprising.
    expect(classifySeverity(3, 0)).toBe("CRITICAL");
  });
});

describe("classifyDiscrepancyStatus", () => {
  it("returns EXPECTED_MISSING when there is no expected balance", () => {
    expect(classifyDiscrepancyStatus({ expectedQuantity: null, observedQuantity: 10 })).toBe("EXPECTED_MISSING");
  });

  it("returns PHYSICAL_UNVERIFIED when there is no physical observation", () => {
    expect(classifyDiscrepancyStatus({ expectedQuantity: 10, observedQuantity: null })).toBe("PHYSICAL_UNVERIFIED");
  });

  it("returns REVIEW_REQUIRED for a low-confidence observation regardless of the numbers matching", () => {
    expect(
      classifyDiscrepancyStatus({ expectedQuantity: 10, observedQuantity: 10, confidenceLevel: "REVIEW_REQUIRED" }),
    ).toBe("REVIEW_REQUIRED");
  });

  it("returns MATCH when expected equals observed", () => {
    expect(classifyDiscrepancyStatus({ expectedQuantity: 10, observedQuantity: 10 })).toBe("MATCH");
  });

  it("returns SHORTAGE when observed is below expected", () => {
    expect(classifyDiscrepancyStatus({ expectedQuantity: 82, observedQuantity: 74 })).toBe("SHORTAGE");
  });

  it("returns SURPLUS when observed is above expected", () => {
    expect(classifyDiscrepancyStatus({ expectedQuantity: 10, observedQuantity: 15 })).toBe("SURPLUS");
  });
});

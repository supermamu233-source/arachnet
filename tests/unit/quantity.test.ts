import { describe, expect, it } from "vitest";
import { calculatePhysicalQuantity } from "@/domain/inventory/quantity";

describe("calculatePhysicalQuantity", () => {
  it("computes boxes * unitsPerBox + looseUnits", () => {
    expect(calculatePhysicalQuantity({ boxes: 12, unitsPerBox: 6, looseUnits: 2 })).toBe(74);
  });

  it("matches the required robot-integration seed case (expected 82, observed 74)", () => {
    const observed = calculatePhysicalQuantity({ boxes: 12, unitsPerBox: 6, looseUnits: 2 });
    const expected = 82;
    expect(observed).toBe(74);
    expect(observed - expected).toBe(-8);
  });

  it("handles zero boxes and zero loose units", () => {
    expect(calculatePhysicalQuantity({ boxes: 0, unitsPerBox: 6, looseUnits: 0 })).toBe(0);
  });

  it("rejects negative boxes", () => {
    expect(() => calculatePhysicalQuantity({ boxes: -1, unitsPerBox: 6, looseUnits: 0 })).toThrow();
  });

  it("rejects negative loose units", () => {
    expect(() => calculatePhysicalQuantity({ boxes: 1, unitsPerBox: 6, looseUnits: -1 })).toThrow();
  });

  it("rejects unitsPerBox below 1", () => {
    expect(() => calculatePhysicalQuantity({ boxes: 1, unitsPerBox: 0, looseUnits: 0 })).toThrow();
  });

  it("rejects non-integer input", () => {
    expect(() => calculatePhysicalQuantity({ boxes: 1.5, unitsPerBox: 6, looseUnits: 0 })).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { isValidEanChecksum, normalizeIdentifier } from "@/domain/products/ean";

describe("isValidEanChecksum", () => {
  it("accepts a known-valid EAN-13", () => {
    expect(isValidEanChecksum("4006381333931")).toBe(true);
  });

  it("accepts a known-valid EAN-8", () => {
    expect(isValidEanChecksum("96385074")).toBe(true);
  });

  it("rejects an EAN-13 with a wrong check digit", () => {
    expect(isValidEanChecksum("4006381333930")).toBe(false);
  });

  it("rejects an EAN-8 with a wrong check digit", () => {
    expect(isValidEanChecksum("96385075")).toBe(false);
  });

  it("rejects the wrong length", () => {
    expect(isValidEanChecksum("123456")).toBe(false);
    expect(isValidEanChecksum("12345678901")).toBe(false);
  });

  it("rejects non-digit characters", () => {
    expect(isValidEanChecksum("400638133393X")).toBe(false);
  });
});

describe("normalizeIdentifier", () => {
  it("trims whitespace and upper-cases", () => {
    expect(normalizeIdentifier("  sku-001 \n")).toBe("SKU-001");
  });

  it("does not correct visually ambiguous characters", () => {
    // O and 0 must remain distinct — never auto-corrected (principle 2.3).
    expect(normalizeIdentifier("SKU-O01")).not.toBe(normalizeIdentifier("SKU-001"));
  });
});

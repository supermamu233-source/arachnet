import { describe, expect, it } from "vitest";
import { findExactMatches, findSuggestions, type CatalogEntry } from "@/domain/products/matching";

const catalog: CatalogEntry[] = [
  { productId: "p1", sku: "SKU-001", barcodes: ["8431234567890"], aliases: ["ALIAS-1"] },
  { productId: "p2", sku: "SKU-002", barcodes: ["8400000000000"], aliases: [] },
];

describe("findExactMatches", () => {
  it("matches an exact EAN", () => {
    const matches = findExactMatches("8431234567890", catalog);
    expect(matches).toEqual([{ productId: "p1", matchType: "EAN", matchedValue: "8431234567890" }]);
  });

  it("matches an exact SKU case-insensitively (whitespace/case normalization only)", () => {
    const matches = findExactMatches(" sku-002 ", catalog);
    expect(matches).toEqual([{ productId: "p2", matchType: "SKU", matchedValue: "SKU-002" }]);
  });

  it("matches an exact configured alias", () => {
    const matches = findExactMatches("alias-1", catalog);
    expect(matches).toEqual([{ productId: "p1", matchType: "ALIAS", matchedValue: "ALIAS-1" }]);
  });

  it("does not match on a character-confusable near-miss (O vs 0)", () => {
    // "SKU-OO1" vs "SKU-001" — visually similar, must NOT auto-match.
    const matches = findExactMatches("SKU-OO1", catalog);
    expect(matches).toEqual([]);
  });

  it("returns no matches for an unknown identifier", () => {
    expect(findExactMatches("does-not-exist", catalog)).toEqual([]);
  });
});

describe("findSuggestions", () => {
  const nameCatalog = [
    { productId: "p1", name: "Detergente Norte", sku: "SKU-001", category: "Limpieza", brand: "Norte" },
    { productId: "p2", name: "Refresco Costa", sku: "SKU-002", category: "Bebidas", brand: "Costa" },
  ];

  it("suggests by name substring but never returns an auto-applied match", () => {
    const suggestions = findSuggestions("Detergente", nameCatalog);
    expect(suggestions).toEqual(["p1"]);
  });

  it("returns an empty list when nothing is similar", () => {
    expect(findSuggestions("Ferretería", nameCatalog)).toEqual([]);
  });
});

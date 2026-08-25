import { normalizeIdentifier } from "@/domain/products/ean";

export type ExactMatchType = "EAN" | "SKU" | "ALIAS";

export interface ExactMatchCandidate {
  productId: string;
  matchType: ExactMatchType;
  matchedValue: string;
}

/** Minimal shape of catalog data needed to classify a match — callers (the
 * products service) fetch this from Prisma; this function stays a pure,
 * DB-free classifier so the exact-matching rule is unit-testable in isolation. */
export interface CatalogEntry {
  productId: string;
  sku: string;
  barcodes: string[];
  aliases: string[];
}

/**
 * Finds exact matches only (product principle 2.3): an exact EAN, exact
 * SKU/reference, or exact configured alias. Name, category, prefix, and OCR
 * text are deliberately excluded — those may only ever produce suggestions
 * for a human (see findSuggestions), never an automatic match.
 */
export function findExactMatches(query: string, catalog: CatalogEntry[]): ExactMatchCandidate[] {
  const normalizedQuery = normalizeIdentifier(query);
  const matches: ExactMatchCandidate[] = [];

  for (const entry of catalog) {
    if (normalizeIdentifier(entry.sku) === normalizedQuery) {
      matches.push({ productId: entry.productId, matchType: "SKU", matchedValue: entry.sku });
      continue;
    }
    const barcodeMatch = entry.barcodes.find((b) => normalizeIdentifier(b) === normalizedQuery);
    if (barcodeMatch) {
      matches.push({ productId: entry.productId, matchType: "EAN", matchedValue: barcodeMatch });
      continue;
    }
    const aliasMatch = entry.aliases.find((a) => normalizeIdentifier(a) === normalizedQuery);
    if (aliasMatch) {
      matches.push({ productId: entry.productId, matchType: "ALIAS", matchedValue: aliasMatch });
    }
  }

  return matches;
}

/**
 * Ranks candidates by a non-exact signal (name/category/brand/SKU-prefix
 * substring) purely for display as human-reviewed suggestions. The caller
 * must never auto-apply the top suggestion — only findExactMatches results
 * may be applied without review.
 */
export function findSuggestions(
  query: string,
  catalog: Array<{ productId: string; name: string; sku: string; category?: string | null; brand?: string | null }>,
): string[] {
  const normalizedQuery = normalizeIdentifier(query);
  return catalog
    .filter((entry) => {
      const haystack = normalizeIdentifier(
        [entry.name, entry.sku, entry.category, entry.brand].filter(Boolean).join(" "),
      );
      return haystack.includes(normalizedQuery) || normalizedQuery.includes(normalizeIdentifier(entry.sku));
    })
    .map((entry) => entry.productId);
}

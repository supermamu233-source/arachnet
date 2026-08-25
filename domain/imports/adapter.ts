/**
 * The connector/adaptor contract every expected-stock source implements
 * (product spec section 3.6): manual entry, CSV, XLSX, and a generic REST
 * API today, with future ERP/POS/e-commerce/accounting integrations meant to
 * plug into the same shape.
 *
 * This file is intentionally pure — no Prisma, no filesystem, no network
 * calls. Concrete adapters (`manual-adapter.ts`, `csv-adapter.ts`,
 * `xlsx-adapter.ts`, `generic-rest-adapter.ts`) implement this interface and
 * do their own I/O; `server/services/imports.ts` is the only place that
 * wires an adapter's output into the database.
 */

/** One page of product-master data from a source. CSV/XLSX/manual adapters
 * in this codebase carry expected-balance data only (see their files for
 * why) and always return an empty batch here — product master data comes
 * from the separate product-intake pipeline. A future ERP/POS adapter that
 * really can enumerate its product catalogue would populate this for real. */
export interface ProductBatchItem {
  /** The source system's own identifier for this product, if it has one
   * distinct from the code. Never used for matching by itself — matching is
   * always by exact SKU/EAN (product principle 2.3). */
  externalId?: string;
  /** SKU or EAN — exact match only against the Arachnet catalogue. */
  code: string;
  name: string;
  category?: string;
  brand?: string;
  variant?: string;
  defaultUnitsPerBox?: number;
}

export interface ProductBatch {
  items: ProductBatchItem[];
  /** Present when there are more pages to fetch; absent/undefined on the
   * last page. */
  nextCursor?: string;
}

/** One expected-balance record from a source: "this product should have
 * this quantity at this location, as of this timestamp". */
export interface BalanceBatchItem {
  /** The source system's own identifier for this balance record, if any
   * (used for traceability in error reports and audit trails — never used
   * for matching). */
  externalId?: string;
  /** SKU or EAN — exact match only, resolved against the catalogue by
   * `getProductLookup`. Never fuzzy-matched. */
  externalProductCode: string;
  /** Location code, exact match only against `Location.code` within the
   * target warehouse. Never fuzzy-matched. */
  locationCode: string;
  quantity: number;
  /** ISO-8601 timestamp string from the source, used as
   * `ExpectedStockBalance.sourceUpdatedAt` so the reconciliation engine can
   * pick the most recent authoritative row per product+location. */
  sourceTimestamp: string;
  /** 1-based row number in the originating file/response, for CSV/XLSX
   * error reporting. Undefined for sources without a natural row concept
   * (e.g. a single manual entry, or a REST response that isn't row-shaped). */
  rowNumber?: number;
}

export interface BalanceBatch {
  items: BalanceBatchItem[];
  nextCursor?: string;
}

/** Summary handed to `acknowledgeImport` after an import job finishes
 * processing. */
export interface ImportResult {
  importJobId: string;
  rowsTotal: number;
  rowsAccepted: number;
  rowsRejected: number;
}

/**
 * The shared contract. Every adapter must validate its own configuration
 * before use, and must never write back to the external system as a side
 * effect of a normal import (see `GenericRestAdapter` for the strongest
 * version of that rule — a proprietary ERP/POS connector built later must
 * follow it too).
 */
export interface InventorySourceAdapter {
  /** Throws if the adapter's configuration is unusable (e.g. a non-HTTPS
   * base URL, a missing required field) — called once before any
   * fetch*, so a bad configuration fails fast with a clear message instead
   * of partway through a paginated fetch. */
  validateConfiguration(): Promise<void>;

  fetchProducts(cursor?: string): Promise<ProductBatch>;

  fetchExpectedBalances(cursor?: string): Promise<BalanceBatch>;

  /**
   * Optional hook called after an import job completes. Per the product
   * spec, this must NEVER write back to the external system (no automatic
   * write-back) — an implementation may at most be a local no-op or update
   * something inside Arachnet's own database. It must not call out to
   * mutate the source.
   */
  acknowledgeImport?(result: ImportResult): Promise<void>;
}

import type { BalanceBatch, InventorySourceAdapter, ProductBatch } from "@/domain/imports/adapter";
import { parseAndValidateBalanceRows, type RowValidationError } from "@/domain/imports/sheet-parsing";

/**
 * Adapter for a user-uploaded CSV file of expected-balance rows. Parsing and
 * row-level validation is fully delegated to `sheet-parsing.ts` (shared with
 * `XlsxAdapter` — SheetJS auto-detects CSV vs. XLSX from the buffer, so the
 * two file types really do share all their parsing logic; only the class
 * name/tag differs).
 *
 * The whole file is already in memory when this adapter is constructed, so
 * there is no real pagination — `fetchExpectedBalances` always returns
 * everything in a single page (`nextCursor` is always undefined).
 *
 * This import type carries expected-balance rows only, not product master
 * data — `fetchProducts` always returns an empty batch. (Product creation
 * goes through the separate product-intake pipeline owned elsewhere in this
 * codebase.)
 */
export class CsvAdapter implements InventorySourceAdapter {
  private readonly buffer: Buffer;
  private parsed?: ReturnType<typeof parseAndValidateBalanceRows>;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  private ensureParsed() {
    if (!this.parsed) {
      this.parsed = parseAndValidateBalanceRows(this.buffer);
    }
    return this.parsed;
  }

  async validateConfiguration(): Promise<void> {
    // Throws synchronously (via ensureParsed) if the buffer can't be read as
    // a CSV/XLSX at all, or is missing a required column.
    this.ensureParsed();
  }

  async fetchProducts(): Promise<ProductBatch> {
    return { items: [] };
  }

  async fetchExpectedBalances(): Promise<BalanceBatch> {
    return { items: this.ensureParsed().accepted };
  }

  /** Rows that failed format-level validation (missing quantity, blank
   * code/location columns, etc.) — not part of the InventorySourceAdapter
   * interface, but used by `server/services/imports.ts` to build the
   * downloadable error report alongside any database-resolution rejections. */
  getFormatRejections(): RowValidationError[] {
    return this.ensureParsed().rejected;
  }

  getRowsTotal(): number {
    return this.ensureParsed().rowsTotal;
  }

  // `acknowledgeImport` is deliberately not implemented: there is no
  // external system to acknowledge to for a file-based source, and the
  // interface marks the hook optional precisely for adapters like this one.
}

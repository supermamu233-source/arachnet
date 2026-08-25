import type { BalanceBatch, InventorySourceAdapter, ProductBatch } from "@/domain/imports/adapter";
import { parseAndValidateBalanceRows, type RowValidationError } from "@/domain/imports/sheet-parsing";

/**
 * Adapter for a user-uploaded XLSX workbook of expected-balance rows.
 * Identical to `CsvAdapter` in every respect except the class name/type tag
 * — SheetJS (`xlsx`) auto-detects the file format from the buffer, so both
 * file types share the exact same parsing/validation code in
 * `sheet-parsing.ts`. Kept as a separate class (rather than one class with a
 * `type` parameter) so `InventoryType`/adapter selection in
 * `server/services/imports.ts` stays a simple 1:1 mapping.
 */
export class XlsxAdapter implements InventorySourceAdapter {
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
    this.ensureParsed();
  }

  async fetchProducts(): Promise<ProductBatch> {
    return { items: [] };
  }

  async fetchExpectedBalances(): Promise<BalanceBatch> {
    return { items: this.ensureParsed().accepted };
  }

  getFormatRejections(): RowValidationError[] {
    return this.ensureParsed().rejected;
  }

  getRowsTotal(): number {
    return this.ensureParsed().rowsTotal;
  }

  // No `acknowledgeImport` — same reasoning as CsvAdapter.
}

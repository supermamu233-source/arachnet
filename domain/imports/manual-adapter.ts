import { z } from "zod";
import type { BalanceBatch, InventorySourceAdapter, ProductBatch } from "@/domain/imports/adapter";

/** A single manually-entered expected balance, from the "manual expected-
 * balance entry" form rather than a bulk file import. */
export interface ManualBalanceEntry {
  code: string;
  locationCode: string;
  quantity: number;
  /** ISO-8601 timestamp; defaults to "now" if omitted. */
  sourceTimestamp?: string;
}

const manualEntrySchema = z.object({
  code: z.string().trim().min(1, "código de producto vacío"),
  locationCode: z.string().trim().min(1, "código de ubicación vacío"),
  quantity: z.number().int().min(0, "cantidad no puede ser negativa"),
  sourceTimestamp: z.string().trim().min(1).optional(),
});

/**
 * Trivial adapter wrapping a single manually-entered balance so it can flow
 * through the exact same `createImportJob` pipeline as a bulk CSV/XLSX
 * import (one accepted row, tagged to a MANUAL `InventorySource`).
 */
export class ManualAdapter implements InventorySourceAdapter {
  private readonly entry: ManualBalanceEntry;

  constructor(entry: ManualBalanceEntry) {
    this.entry = entry;
  }

  async validateConfiguration(): Promise<void> {
    // Throws a zod error synchronously if the entry itself is malformed —
    // callers should still treat that as a row-level rejection rather than a
    // whole-job failure where practical (see server/services/imports.ts).
    manualEntrySchema.parse(this.entry);
  }

  async fetchProducts(): Promise<ProductBatch> {
    return { items: [] };
  }

  async fetchExpectedBalances(): Promise<BalanceBatch> {
    const parsed = manualEntrySchema.parse(this.entry);
    return {
      items: [
        {
          externalProductCode: parsed.code,
          locationCode: parsed.locationCode,
          quantity: parsed.quantity,
          sourceTimestamp: parsed.sourceTimestamp ?? new Date().toISOString(),
          rowNumber: 1,
        },
      ],
    };
  }

  // No `acknowledgeImport` — there is no external source for a manual entry.
}

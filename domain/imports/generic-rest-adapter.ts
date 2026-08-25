import { z } from "zod";
import type {
  BalanceBatch,
  BalanceBatchItem,
  ImportResult,
  InventorySourceAdapter,
  ProductBatch,
  ProductBatchItem,
} from "@/domain/imports/adapter";
import type { RowValidationError } from "@/domain/imports/sheet-parsing";

/**
 * Configuration for a generic REST inventory source, per product spec
 * section 3.6: HTTPS only, configurable auth (a static Bearer token covers
 * the MVP requirement — no full OAuth flow), cursor-based pagination, basic
 * retry-with-backoff, and no automatic write-back.
 *
 * The wire contract this adapter expects from the remote API is fixed for
 * MVP (documented in `BalanceWireItem`/`ProductWireItem` below) rather than
 * field-mapping-configurable — a real proprietary ERP/POS connector would
 * likely need a translation layer on top of this, which is explicitly out of
 * scope here (see the file-level product-spec note about not implementing
 * specific proprietary ERPs without credentials/docs).
 */
export interface GenericRestConfig {
  baseUrl: string;
  bearerToken?: string;
  productsPath?: string;
  balancesPath?: string;
  /** Number of retries after the first attempt on a transient (network
   * error or 5xx) failure. Defaults to 2 — enough for MVP, not a full
   * exponential-backoff policy tuned for production scale. */
  maxRetries?: number;
}

const configSchema = z.object({
  baseUrl: z.url(),
  bearerToken: z.string().min(1).optional(),
  productsPath: z.string().min(1).default("/products"),
  balancesPath: z.string().min(1).default("/expected-balances"),
  maxRetries: z.number().int().min(0).max(5).default(2),
});

const productWireItemSchema = z.object({
  externalId: z.string().min(1).optional(),
  code: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1).optional(),
  brand: z.string().min(1).optional(),
  variant: z.string().min(1).optional(),
  defaultUnitsPerBox: z.number().int().min(1).optional(),
});

const balanceWireItemSchema = z.object({
  externalId: z.string().min(1).optional(),
  productCode: z.string().min(1),
  locationCode: z.string().min(1),
  quantity: z.number().int().min(0),
  updatedAt: z.string().min(1),
});

const wirePageSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().optional(),
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Adapter for a generic, configurably-authenticated REST inventory source.
 * Deliberately the only adapter here that does real network I/O — no
 * specific proprietary ERP/POS/e-commerce system is implemented against
 * (per the product spec's own instruction not to build those without
 * credentials/docs), but any system able to speak this fixed JSON contract
 * over HTTPS can be wired up through it.
 */
export class GenericRestAdapter implements InventorySourceAdapter {
  private readonly config: z.infer<typeof configSchema>;
  private itemsSeen = 0;
  private readonly rejections: RowValidationError[] = [];

  constructor(config: GenericRestConfig) {
    // Parsed eagerly so a malformed config (missing baseUrl, retry count out
    // of range, etc.) fails at construction, before validateConfiguration or
    // any fetch is even attempted.
    this.config = configSchema.parse(config);
  }

  async validateConfiguration(): Promise<void> {
    if (!this.config.baseUrl.toLowerCase().startsWith("https://")) {
      throw new Error(
        `Generic REST source configuration must use HTTPS; got "${this.config.baseUrl}".`,
      );
    }
  }

  private authHeaders(): HeadersInit {
    return this.config.bearerToken ? { Authorization: `Bearer ${this.config.bearerToken}` } : {};
  }

  private buildUrl(path: string, cursor?: string): string {
    const url = new URL(path, this.config.baseUrl);
    if (cursor) url.searchParams.set("cursor", cursor);
    return url.toString();
  }

  private async fetchWithRetry(url: string, attempt = 0): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, { headers: this.authHeaders() });
    } catch (error) {
      if (attempt < this.config.maxRetries) {
        await sleep(200 * 2 ** attempt);
        return this.fetchWithRetry(url, attempt + 1);
      }
      throw error;
    }

    // Only 5xx is treated as transient/retryable — a 4xx (bad auth, bad
    // request) retrying would just repeat the same failure.
    if (response.status >= 500 && attempt < this.config.maxRetries) {
      await sleep(200 * 2 ** attempt);
      return this.fetchWithRetry(url, attempt + 1);
    }
    return response;
  }

  private async fetchWirePage(path: string, cursor?: string): Promise<{ items: unknown[]; nextCursor?: string }> {
    const url = this.buildUrl(path, cursor);
    const response = await this.fetchWithRetry(url);
    if (!response.ok) {
      // A whole-page failure (even after retries) is an adapter-level
      // problem, not a per-row rejection — it surfaces as the whole import
      // job FAILING, per the "reserve FAILED for the whole import blowing
      // up" convention in server/services/imports.ts.
      throw new Error(`Generic REST source returned ${response.status} for ${url}`);
    }
    const body: unknown = await response.json();
    return wirePageSchema.parse(body);
  }

  async fetchProducts(cursor?: string): Promise<ProductBatch> {
    const page = await this.fetchWirePage(this.config.productsPath, cursor);
    const items: ProductBatchItem[] = [];
    page.items.forEach((raw, index) => {
      const parsed = productWireItemSchema.safeParse(raw);
      if (!parsed.success) {
        this.rejections.push({
          rowNumber: this.itemsSeen + index + 1,
          reason: `Elemento de producto inválido en la página (cursor=${cursor ?? "inicial"}): ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        });
        return;
      }
      items.push({ ...parsed.data });
    });
    this.itemsSeen += page.items.length;
    return { items, nextCursor: page.nextCursor };
  }

  async fetchExpectedBalances(cursor?: string): Promise<BalanceBatch> {
    const page = await this.fetchWirePage(this.config.balancesPath, cursor);
    const items: BalanceBatchItem[] = [];
    page.items.forEach((raw, index) => {
      const parsed = balanceWireItemSchema.safeParse(raw);
      const rowNumber = this.itemsSeen + index + 1;
      if (!parsed.success) {
        this.rejections.push({
          rowNumber,
          reason: `Elemento de balance inválido en la página (cursor=${cursor ?? "inicial"}): ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        });
        return;
      }
      items.push({
        externalId: parsed.data.externalId,
        externalProductCode: parsed.data.productCode,
        locationCode: parsed.data.locationCode,
        quantity: parsed.data.quantity,
        sourceTimestamp: parsed.data.updatedAt,
        rowNumber,
      });
    });
    this.itemsSeen += page.items.length;
    return { items, nextCursor: page.nextCursor };
  }

  /** Wire-level item rejections accumulated across every page fetched so
   * far — same purpose as `CsvAdapter.getFormatRejections`, exposed the
   * same way (not part of the shared interface). */
  getFormatRejections(): RowValidationError[] {
    return this.rejections;
  }

  /**
   * Explicitly a local no-op: the product spec requires that no adapter
   * ever writes back to the external system automatically. A real
   * acknowledgment endpoint on the remote source is intentionally NOT
   * called here — if a future integration needs that, it must be a
   * separate, explicitly user-triggered action, never an automatic part of
   * import processing.
   */
  async acknowledgeImport(_result: ImportResult): Promise<void> {
    void _result;
  }
}

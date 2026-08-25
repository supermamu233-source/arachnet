import * as XLSX from "xlsx";
import { z } from "zod";
import type { BalanceBatchItem } from "@/domain/imports/adapter";

/**
 * Shared, DB-free parsing + row-level validation for the CSV and XLSX
 * adapters. SheetJS (`xlsx`) auto-detects CSV vs. XLSX from the buffer
 * contents, so both file types funnel through the exact same code here —
 * only the two adapter classes differ, and only in name/type tagging.
 *
 * Deliberately has no Prisma/IO of its own so it can be unit-tested directly
 * without a database: this is the "row has a missing/invalid quantity" /
 * "row's code or location column is blank/malformed" validation. Whether a
 * structurally-valid code or location actually EXISTS in the catalogue is a
 * database lookup and happens one layer up, in
 * `server/services/imports.ts`.
 */

export interface RowValidationError {
  rowNumber: number;
  reason: string;
}

export interface ParseAndValidateResult {
  rowsTotal: number;
  accepted: BalanceBatchItem[];
  rejected: RowValidationError[];
}

/** Known header aliases (case/space/accent-insensitive) for each logical
 * column. Kept intentionally small for MVP — extend here if a real-world
 * export uses another common header name. */
const HEADER_ALIASES: Record<"code" | "locationCode" | "quantity" | "timestamp" | "externalId", string[]> = {
  code: ["code", "sku", "ean", "codigo", "referencia"],
  locationCode: ["location", "locationcode", "location_code", "ubicacion", "ubicación"],
  quantity: ["quantity", "qty", "cantidad", "stock"],
  timestamp: ["timestamp", "date", "fecha", "updatedat", "updated_at"],
  externalId: ["externalid", "external_id", "id"],
};

function normalizeHeader(header: string): string {
  return header
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining accents after NFD normalization
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function buildHeaderMap(rawHeaders: string[]): Partial<Record<keyof typeof HEADER_ALIASES, string>> {
  const map: Partial<Record<keyof typeof HEADER_ALIASES, string>> = {};
  for (const rawHeader of rawHeaders) {
    const normalized = normalizeHeader(rawHeader);
    for (const [logical, aliases] of Object.entries(HEADER_ALIASES) as [
      keyof typeof HEADER_ALIASES,
      string[],
    ][]) {
      if (map[logical]) continue;
      if (aliases.some((alias) => normalizeHeader(alias) === normalized)) {
        map[logical] = rawHeader;
      }
    }
  }
  return map;
}

const rawRowSchema = z.object({
  code: z.string().trim().min(1, "código de producto vacío"),
  locationCode: z.string().trim().min(1, "código de ubicación vacío"),
  // Coerced explicitly (rather than via z.coerce.number(), which would turn
  // a missing/null value into 0 instead of rejecting it) so a blank
  // quantity cell is always a rejection, never a silent zero. Converts a
  // missing/blank/non-numeric cell to `undefined` (not NaN) before it
  // reaches z.number() — NaN fails z.number()'s own built-in type check
  // first, before any .refine() runs, which would otherwise bury our
  // Spanish message behind Zod's generic English "expected number, received
  // NaN" one.
  quantity: z
    .preprocess((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = typeof val === "number" ? val : Number(val);
      return Number.isNaN(num) ? undefined : num;
    }, z.number({ error: "cantidad ausente o no numérica" }))
    .refine((val) => Number.isInteger(val), { message: "cantidad debe ser un entero" })
    .refine((val) => val >= 0, { message: "cantidad no puede ser negativa" }),
  sourceTimestamp: z.string().trim().min(1),
  externalId: z.string().trim().min(1).optional(),
});

/**
 * Parses a raw uploaded buffer (CSV or XLSX) into validated balance rows.
 * Row numbers reported in `rejected`/`rowNumber` count the header row as
 * row 1, matching what a user sees if they open the file in a spreadsheet
 * app — so the first data row is row 2.
 */
export function parseAndValidateBalanceRows(buffer: Buffer): ParseAndValidateResult {
  let rawRows: Record<string, unknown>[];
  try {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new Error("El archivo no contiene ninguna hoja.");
    }
    const sheet = workbook.Sheets[sheetName];
    rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true });
  } catch (error) {
    throw new Error(
      `No se pudo leer el archivo como CSV/XLSX: ${error instanceof Error ? error.message : "error desconocido"}`,
    );
  }

  if (rawRows.length === 0) {
    return { rowsTotal: 0, accepted: [], rejected: [] };
  }

  const headerMap = buildHeaderMap(Object.keys(rawRows[0]));
  const missingColumns: string[] = [];
  if (!headerMap.code) missingColumns.push("código (SKU/EAN)");
  if (!headerMap.locationCode) missingColumns.push("ubicación");
  if (!headerMap.quantity) missingColumns.push("cantidad");
  if (missingColumns.length > 0) {
    throw new Error(`El archivo no tiene las columnas requeridas: ${missingColumns.join(", ")}.`);
  }

  const accepted: BalanceBatchItem[] = [];
  const rejected: RowValidationError[] = [];

  rawRows.forEach((rawRow, index) => {
    const rowNumber = index + 2; // +1 for 1-based, +1 for the header row
    const codeValue = headerMap.code ? rawRow[headerMap.code] : null;
    const locationValue = headerMap.locationCode ? rawRow[headerMap.locationCode] : null;
    const quantityValue = headerMap.quantity ? rawRow[headerMap.quantity] : null;
    const timestampValue = headerMap.timestamp ? rawRow[headerMap.timestamp] : null;
    const externalIdValue = headerMap.externalId ? rawRow[headerMap.externalId] : null;

    const candidate = {
      code: codeValue == null ? "" : String(codeValue),
      locationCode: locationValue == null ? "" : String(locationValue),
      quantity: quantityValue,
      sourceTimestamp:
        timestampValue == null || timestampValue === "" ? new Date().toISOString() : String(timestampValue),
      externalId: externalIdValue == null || externalIdValue === "" ? undefined : String(externalIdValue),
    };

    const result = rawRowSchema.safeParse(candidate);
    if (!result.success) {
      const reason = result.error.issues
        .map((issue) => `${String(issue.path[0] ?? "fila")}: ${issue.message}`)
        .join("; ");
      rejected.push({ rowNumber, reason: `Fila inválida (${reason}).` });
      return;
    }

    accepted.push({
      externalId: result.data.externalId,
      externalProductCode: result.data.code,
      locationCode: result.data.locationCode,
      quantity: result.data.quantity,
      sourceTimestamp: result.data.sourceTimestamp,
      rowNumber,
    });
  });

  return { rowsTotal: rawRows.length, accepted, rejected };
}

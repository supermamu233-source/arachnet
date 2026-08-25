import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { parseAndValidateBalanceRows } from "@/domain/imports/sheet-parsing";

function csvBuffer(csv: string): Buffer {
  return Buffer.from(csv, "utf-8");
}

function xlsxBuffer(rows: Record<string, unknown>[]): Buffer {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("parseAndValidateBalanceRows", () => {
  it("accepts a well-formed CSV row", () => {
    const result = parseAndValidateBalanceRows(csvBuffer("sku,location,quantity\nSKU-1,A01,82\n"));
    expect(result.rowsTotal).toBe(1);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0]).toMatchObject({ externalProductCode: "SKU-1", locationCode: "A01", quantity: 82 });
  });

  it("recognizes Spanish header aliases (codigo/ubicacion/cantidad)", () => {
    const result = parseAndValidateBalanceRows(csvBuffer("codigo,ubicacion,cantidad\nSKU-2,B02,10\n"));
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].externalProductCode).toBe("SKU-2");
  });

  it("rejects a row with a missing quantity, without silently defaulting to zero", () => {
    const result = parseAndValidateBalanceRows(csvBuffer("sku,location,quantity\nSKU-1,A01,\n"));
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/cantidad/);
  });

  it("rejects a negative quantity", () => {
    const result = parseAndValidateBalanceRows(csvBuffer("sku,location,quantity\nSKU-1,A01,-5\n"));
    expect(result.rejected).toHaveLength(1);
  });

  it("rejects a non-integer quantity", () => {
    const result = parseAndValidateBalanceRows(csvBuffer("sku,location,quantity\nSKU-1,A01,4.5\n"));
    expect(result.rejected).toHaveLength(1);
  });

  it("rejects a row with a blank product code", () => {
    const result = parseAndValidateBalanceRows(csvBuffer("sku,location,quantity\n,A01,5\n"));
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/código/i);
  });

  it("reports row numbers counting the header as row 1", () => {
    const result = parseAndValidateBalanceRows(csvBuffer("sku,location,quantity\nSKU-1,A01,5\nSKU-2,B02,\n"));
    expect(result.rejected[0].rowNumber).toBe(3);
  });

  it("processes accepted and rejected rows independently within the same file", () => {
    const result = parseAndValidateBalanceRows(
      csvBuffer("sku,location,quantity\nSKU-1,A01,5\nSKU-2,B02,\nSKU-3,C03,20\n"),
    );
    expect(result.rowsTotal).toBe(3);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
  });

  it("throws when required columns are entirely missing", () => {
    expect(() => parseAndValidateBalanceRows(csvBuffer("foo,bar\n1,2\n"))).toThrow(/columnas requeridas/);
  });

  it("returns an empty result for a header-only file with no data rows", () => {
    const result = parseAndValidateBalanceRows(csvBuffer("sku,location,quantity\n"));
    expect(result.rowsTotal).toBe(0);
    expect(result.accepted).toHaveLength(0);
  });

  it("parses an XLSX buffer identically to the equivalent CSV", () => {
    const result = parseAndValidateBalanceRows(
      xlsxBuffer([{ sku: "SKU-1", location: "A01", quantity: 82 }]),
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({ externalProductCode: "SKU-1", locationCode: "A01", quantity: 82 });
  });
});

import { parse } from "csv-parse/sync";
import { nanoid } from "nanoid";
import readXlsxFile from "read-excel-file/node";
import type { GlCode, GlImportSkippedRow } from "./types";

type ParsedRow = Record<string, unknown>;

const REQUIRED_HEADERS = ["gl code", "description", "keywords"];

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

function getField(row: ParsedRow, fieldName: string): string {
  const matchedKey = Object.keys(row).find((key) => normalizeHeader(key) === fieldName);
  const value = matchedKey ? row[matchedKey] : "";
  return String(value ?? "").trim();
}

function splitKeywords(rawKeywords: string): string[] {
  return rawKeywords
    .split(/[,;\n]/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function parseCsv(buffer: Buffer): ParsedRow[] {
  return parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true
  });
}

async function parseWorkbook(buffer: Buffer): Promise<ParsedRow[]> {
  const workbook = await readXlsxFile(buffer);
  const rows = workbook[0]?.data || [];
  const [headerRow, ...dataRows] = rows;
  const headers = (headerRow || []).map((header: unknown) => String(header ?? "").trim());

  return dataRows.map((row) => {
    return headers.reduce<ParsedRow>((record: ParsedRow, header: string, index: number) => {
      record[header] = row[index] ?? "";
      return record;
    }, {});
  });
}

export async function parseGlFile(buffer: Buffer, fileName: string): Promise<{
  codes: GlCode[];
  skippedRows: GlImportSkippedRow[];
}> {
  const extension = fileName.toLowerCase().split(".").pop();
  const rows = extension === "xlsx" || extension === "xls" ? await parseWorkbook(buffer) : parseCsv(buffer);
  const firstRow = rows[0] || {};
  const normalizedHeaders = Object.keys(firstRow).map(normalizeHeader);
  const missingHeaders = REQUIRED_HEADERS.filter((header) => !normalizedHeaders.includes(header));

  if (missingHeaders.length > 0) {
    throw new Error(`Missing required GL import columns: ${missingHeaders.join(", ")}`);
  }

  const skippedRows: GlImportSkippedRow[] = [];
  const codes: GlCode[] = [];
  const seenCodes = new Set<string>();

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const code = getField(row, "gl code");
    const description = getField(row, "description");
    const rawKeywords = getField(row, "keywords");

    if (!code || code.includes("#VALUE!") || description.includes("#VALUE!")) {
      skippedRows.push({ rowNumber, reason: "Invalid or blank GL code row", raw: row });
      return;
    }

    if (!/^\d+$/.test(code)) {
      skippedRows.push({ rowNumber, reason: "GL code must contain digits only", raw: row });
      return;
    }

    if (!description) {
      skippedRows.push({ rowNumber, reason: "Description is required", raw: row });
      return;
    }

    if (seenCodes.has(code)) {
      skippedRows.push({ rowNumber, reason: "Duplicate GL code in import", raw: row });
      return;
    }

    seenCodes.add(code);
    codes.push({
      id: nanoid(),
      code,
      description,
      rawKeywords,
      keywords: splitKeywords(rawKeywords),
      active: true
    });
  });

  return { codes, skippedRows };
}

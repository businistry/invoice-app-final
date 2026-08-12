import fs from "node:fs";
import path from "node:path";
import readXlsxFile from "read-excel-file/node";

/**
 * Converts the hand-formatted "Master Chart of Accounts" workbook into the flat
 * CSV that /api/gl-codes/import expects.
 *
 * The workbook is laid out for humans, not machines: column A holds decorative
 * vertical lettering, column B holds parent categories, and the real accounts sit
 * in column C as "43050 · Cleaning & Janitorial Supplies". There is no header row.
 *
 * Usage: npx tsx scripts/convertChartOfAccounts.ts <input.xlsx> [output.csv]
 */

const CODE_PATTERN = /^\s*(\d+)\s*[·.]\s*(.+?)\s*$/;

const CODE_COLUMN = 2;
const CATEGORY_COLUMN = 1;
const KEYWORDS_COLUMN = 3;

type Row = Array<string | null>;

type ChartRecord = {
  code: string;
  description: string;
  keywords: string;
  category: string;
};

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function recordsFromRows(rows: Row[]): { records: ChartRecord[]; unparsed: string[] } {
  const records: ChartRecord[] = [];
  const unparsed: string[] = [];
  let category = "";

  rows.forEach((row) => {
    const cell = (index: number) => String(row[index] ?? "").trim();
    const parentCell = cell(CATEGORY_COLUMN);
    const codeCell = cell(CODE_COLUMN);

    if (parentCell && !codeCell) {
      const parentMatch = parentCell.match(CODE_PATTERN);
      category = parentMatch ? parentMatch[2] : parentCell;
      return;
    }

    if (!codeCell) return;

    const match = codeCell.match(CODE_PATTERN);
    if (!match) {
      unparsed.push(codeCell);
      return;
    }

    records.push({
      code: match[1],
      description: match[2],
      keywords: cell(KEYWORDS_COLUMN),
      category
    });
  });

  return { records, unparsed };
}

async function main(): Promise<void> {
  const [inputPath, outputArg] = process.argv.slice(2);
  if (!inputPath) {
    console.error("Usage: npx tsx scripts/convertChartOfAccounts.ts <input.xlsx> [output.csv]");
    process.exit(1);
  }

  const outputPath = outputArg || path.join(process.cwd(), "data", "gl-codes-import.csv");
  const workbook = await readXlsxFile(fs.readFileSync(inputPath));
  const rows = ((workbook as unknown as Array<{ data: Row[] }>)[0]?.data || []) as Row[];
  const { records, unparsed } = recordsFromRows(rows);

  const duplicates = records.map((record) => record.code).filter((code, index, all) => all.indexOf(code) !== index);

  const header = ["GL Code", "Description", "Keywords", "Category"].map(csvField).join(",");
  const body = records
    .map((record) => [record.code, record.description, record.keywords, record.category].map(csvField).join(","))
    .join("\n");

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${header}\n${body}\n`, "utf8");

  console.log(`Wrote ${records.length} GL codes to ${outputPath}`);
  console.log(`Codes with no keywords: ${records.filter((record) => !record.keywords).length}`);
  if (duplicates.length > 0) console.log(`Duplicate codes: ${duplicates.join(", ")}`);
  if (unparsed.length > 0) console.log(`Unparsed rows: ${unparsed.join(" | ")}`);
}

main();

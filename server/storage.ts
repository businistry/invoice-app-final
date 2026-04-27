import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { parseGlFile } from "./glImport";
import type { AppDb, GlImportReport, InvoiceRecord, StampSettings } from "./types";

export const dataDir = path.join(process.cwd(), "data");
export const originalsDir = path.join(dataDir, "originals");
export const finalizedDir = path.join(dataDir, "finalized");
export const tempDir = path.join(dataDir, "tmp");

const dbPath = path.join(dataDir, "db.json");

const defaultSettings: StampSettings = {
  gmInitials: process.env.GM_INITIALS || "TC",
  autoConfidenceThreshold: 0.72
};

function ensureStorage(): void {
  [dataDir, originalsDir, finalizedDir, tempDir].forEach((directory) => {
    fs.mkdirSync(directory, { recursive: true });
  });
}

function emptyDb(): AppDb {
  return {
    glCodes: [],
    invoices: [],
    settings: defaultSettings,
    importReports: []
  };
}

export function readDb(): AppDb {
  ensureStorage();
  if (!fs.existsSync(dbPath)) {
    const db = emptyDb();
    writeDb(db);
    return db;
  }

  const parsed = JSON.parse(fs.readFileSync(dbPath, "utf8")) as AppDb;
  return {
    ...emptyDb(),
    ...parsed,
    settings: { ...defaultSettings, ...(parsed.settings || {}) }
  };
}

export function writeDb(db: AppDb): void {
  ensureStorage();
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

export function updateInvoice(invoice: InvoiceRecord): InvoiceRecord {
  const db = readDb();
  const index = db.invoices.findIndex((record) => record.id === invoice.id);
  if (index === -1) {
    db.invoices.unshift(invoice);
  } else {
    db.invoices[index] = invoice;
  }
  writeDb(db);
  return invoice;
}

export async function seedGlCodesIfNeeded(): Promise<GlImportReport | null> {
  const db = readDb();
  if (db.glCodes.length > 0) return null;

  const seedPath = process.env.GL_SEED_PATH || "/Users/t.curry/invoiceai/uploads/1772335899022-GL_Codes_Transformed.csv";
  if (!fs.existsSync(seedPath)) return null;

  const buffer = fs.readFileSync(seedPath);
  const report = await importGlCodes(buffer, path.basename(seedPath));
  return report;
}

export async function importGlCodes(buffer: Buffer, fileName: string): Promise<GlImportReport> {
  const parsed = await parseGlFile(buffer, fileName);
  const db = readDb();
  const report: GlImportReport = {
    id: nanoid(),
    importedAt: new Date().toISOString(),
    fileName,
    importedCount: parsed.codes.length,
    skippedRows: parsed.skippedRows
  };

  db.glCodes = parsed.codes;
  db.importReports.unshift(report);
  writeDb(db);
  return report;
}

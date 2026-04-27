import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cors from "cors";
import express from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { buildFinalPdfName, uniqueFilePath } from "./filename";
import { matchGlCodes } from "./glMatcher";
import { extractInvoiceFromPdf } from "./invoiceExtractor";
import { stampPdf } from "./pdfStamp";
import {
  finalizedDir,
  importGlCodes,
  originalsDir,
  readDb,
  seedGlCodesIfNeeded,
  tempDir,
  updateInvoice,
  writeDb
} from "./storage";
import type { InvoiceGlLine, InvoiceRecord, StampPlacement } from "./types";

const app = express();
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "0.0.0.0";

fs.mkdirSync(tempDir, { recursive: true });
const upload = multer({ dest: tempDir });

function requirePrivateAccess(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    next();
    return;
  }

  const user = process.env.APP_USER || "admin";
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  const decoded = encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";

  if (scheme === "Basic" && decoded === `${user}:${password}`) {
    next();
    return;
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Invoice Approval"');
  res.status(401).send("Authentication required");
}

function moneyTotal(lines: InvoiceGlLine[]): number {
  return Number(lines.reduce((sum, line) => sum + Number(line.amount || 0), 0).toFixed(2));
}

function defaultPlacement(): StampPlacement {
  return { pageIndex: 0, x: 44, y: 44, width: 380, height: 128 };
}

function initialGlLines(invoice: InvoiceRecord): InvoiceGlLine[] {
  const total = invoice.extraction.totalAmount;
  const topSuggestion = invoice.glSuggestions[0];
  if (!topSuggestion || topSuggestion.score < 0.45 || typeof total !== "number") return [];

  return [
    {
      glCode: topSuggestion.glCode,
      description: topSuggestion.description,
      amount: total,
      confidence: topSuggestion.score,
      source: "rule"
    }
  ];
}

function validationWarnings(invoice: InvoiceRecord): string[] {
  const warnings: string[] = [];
  if (!invoice.extraction.vendorName) warnings.push("Vendor name is missing.");
  if (!invoice.extraction.invoiceNumber) warnings.push("Invoice number is missing.");
  if (typeof invoice.extraction.totalAmount !== "number") warnings.push("Invoice total is missing.");
  if (invoice.glLines.length === 0) warnings.push("No GL line is selected.");
  if (invoice.glLines.length > 3) warnings.push("Only three GL lines can be stamped.");
  if (typeof invoice.extraction.totalAmount === "number" && moneyTotal(invoice.glLines) !== Number(invoice.extraction.totalAmount.toFixed(2))) {
    warnings.push("GL line amounts must equal the invoice total.");
  }
  return warnings;
}

function displayWarnings(invoice: InvoiceRecord): string[] {
  return [...invoice.extraction.warnings, ...validationWarnings(invoice)];
}

function canAutoFinalize(invoice: InvoiceRecord, threshold: number): boolean {
  const topSuggestion = invoice.glSuggestions[0];
  if (!topSuggestion) return false;

  return (
    invoice.extraction.confidence >= threshold &&
    topSuggestion.score >= 0.68 &&
    validationWarnings(invoice).length === 0
  );
}

function getInvoiceOr404(req: express.Request, res: express.Response): InvoiceRecord | null {
  const db = readDb();
  const invoice = db.invoices.find((record) => record.id === req.params.id);
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return null;
  }
  return invoice;
}

async function finalizeInvoice(invoice: InvoiceRecord): Promise<InvoiceRecord> {
  const db = readDb();
  const settings = db.settings;
  const warnings = validationWarnings(invoice);
  if (warnings.length > 0) {
    invoice.status = "needs_review";
    invoice.warnings = displayWarnings(invoice);
    return updateInvoice(invoice);
  }

  const desiredName = buildFinalPdfName(invoice.extraction.vendorName, invoice.extraction.invoiceNumber);
  const target = uniqueFilePath(finalizedDir, desiredName);
  await stampPdf({
    sourcePath: invoice.originalPath,
    destinationPath: target.fullPath,
    placement: invoice.stampPlacement,
    glLines: invoice.glLines,
    totalAmount: invoice.extraction.totalAmount || 0,
    settings,
    approvalDate: new Date()
  });

  invoice.finalFileName = target.fileName;
  invoice.finalPath = target.fullPath;
  invoice.finalizedAt = new Date().toISOString();
  invoice.status = invoice.status === "auto_finalized" ? "auto_finalized" : "finalized";
  invoice.warnings = [];
  return updateInvoice(invoice);
}

app.use(requirePrivateAccess);
app.use(cors());
app.use(express.json({ limit: "5mb" }));

await seedGlCodesIfNeeded();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", (_req, res) => {
  const db = readDb();
  res.json({ settings: db.settings, hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY) });
});

app.get("/api/gl-codes", (_req, res) => {
  const db = readDb();
  res.json({ glCodes: db.glCodes, importReports: db.importReports });
});

app.post("/api/gl-codes/import", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  try {
    const report = await importGlCodes(fs.readFileSync(req.file.path), req.file.originalname);
    fs.unlinkSync(req.file.path);
    res.json({ report, glCodes: readDb().glCodes });
  } catch (error) {
    fs.unlinkSync(req.file.path);
    res.status(400).json({ error: error instanceof Error ? error.message : "Import failed" });
  }
});

app.get("/api/settings/stamp", (_req, res) => {
  res.json(readDb().settings);
});

app.put("/api/settings/stamp", (req, res) => {
  const db = readDb();
  db.settings = {
    ...db.settings,
    gmInitials: String(req.body.gmInitials || "").trim().slice(0, 12) || "TC",
    autoConfidenceThreshold: Math.min(Math.max(Number(req.body.autoConfidenceThreshold || 0.72), 0.2), 0.95)
  };
  writeDb(db);
  res.json(db.settings);
});

app.get("/api/invoices", (_req, res) => {
  const db = readDb();
  res.json({ invoices: db.invoices });
});

app.post("/api/invoices/upload", upload.array("files"), async (req, res) => {
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length === 0) {
    res.status(400).json({ error: "No PDF files uploaded" });
    return;
  }

  const db = readDb();
  const uploaded: InvoiceRecord[] = [];

  for (const file of files) {
    const id = nanoid();
    const originalPath = path.join(originalsDir, `${id}.pdf`);
    fs.renameSync(file.path, originalPath);

    const buffer = fs.readFileSync(originalPath);
    const extraction = await extractInvoiceFromPdf(buffer, file.originalname);
    const glSuggestions = matchGlCodes(extraction, db.glCodes, db.invoices);
    let invoice: InvoiceRecord = {
      id,
      originalName: file.originalname,
      originalPath,
      uploadedAt: new Date().toISOString(),
      status: "needs_review",
      extraction,
      glSuggestions,
      glLines: [],
      stampPlacement: defaultPlacement(),
      warnings: []
    };

    invoice.glLines = initialGlLines(invoice);
    invoice.warnings = displayWarnings(invoice);

    if (canAutoFinalize(invoice, db.settings.autoConfidenceThreshold)) {
      invoice.status = "auto_finalized";
      invoice = await finalizeInvoice(invoice);
    } else {
      invoice = updateInvoice(invoice);
    }

    uploaded.push(invoice);
  }

  res.json({ invoices: uploaded });
});

app.patch("/api/invoices/:id", (req, res) => {
  const invoice = getInvoiceOr404(req, res);
  if (!invoice) return;

  invoice.extraction = {
    ...invoice.extraction,
    ...req.body.extraction,
    totalAmount:
      req.body.extraction && "totalAmount" in req.body.extraction
        ? Number(req.body.extraction.totalAmount)
        : invoice.extraction.totalAmount
  };
  invoice.glLines = Array.isArray(req.body.glLines) ? req.body.glLines.slice(0, 3) : invoice.glLines;
  invoice.stampPlacement = { ...invoice.stampPlacement, ...(req.body.stampPlacement || {}) };
  invoice.status = invoice.finalPath ? "finalized" : "needs_review";
  invoice.warnings = displayWarnings(invoice);

  const db = readDb();
  invoice.glSuggestions = matchGlCodes(invoice.extraction, db.glCodes, db.invoices);
  updateInvoice(invoice);
  res.json(invoice);
});

app.post("/api/invoices/:id/finalize", async (req, res) => {
  const invoice = getInvoiceOr404(req, res);
  if (!invoice) return;

  try {
    const finalized = await finalizeInvoice(invoice);
    if (finalized.warnings.length > 0) {
      res.status(400).json(finalized);
      return;
    }
    res.json(finalized);
  } catch (error) {
    invoice.status = "error";
    invoice.error = error instanceof Error ? error.message : "PDF stamping failed";
    updateInvoice(invoice);
    res.status(500).json(invoice);
  }
});

app.get("/api/invoices/:id/original.pdf", (req, res) => {
  const invoice = getInvoiceOr404(req, res);
  if (!invoice) return;
  res.sendFile(invoice.originalPath);
});

app.get("/api/invoices/:id/final.pdf", (req, res) => {
  const invoice = getInvoiceOr404(req, res);
  if (!invoice) return;
  if (!invoice.finalPath || !invoice.finalFileName) {
    res.status(404).json({ error: "Final PDF is not available" });
    return;
  }
  res.download(invoice.finalPath, invoice.finalFileName);
});

const distPath = path.join(process.cwd(), "dist");
if (process.env.NODE_ENV === "production" && fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api")) {
      res.sendFile(path.join(distPath, "index.html"));
      return;
    }
    next();
  });
}

function getLanUrls(): string[] {
  const interfaces = os.networkInterfaces();
  return Object.values(interfaces)
    .flatMap((entries) => entries || [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => `http://${entry.address}:${port}`);
}

app.listen(port, host, () => {
  console.log(`Invoice approval app running locally at http://localhost:${port}`);
  getLanUrls().forEach((url) => {
    console.log(`Windows/LAN access: ${url}`);
  });
});

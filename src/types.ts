export type InvoiceStatus = "needs_review" | "auto_finalized" | "finalized" | "error";

export type GlCode = {
  id: string;
  code: string;
  description: string;
  keywords: string[];
  rawKeywords: string;
  active: boolean;
};

export type GlImportReport = {
  id: string;
  importedAt: string;
  fileName: string;
  importedCount: number;
  skippedRows: Array<{ rowNumber: number; reason: string; raw: Record<string, unknown> }>;
};

export type InvoiceExtraction = {
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string;
  totalAmount: number | null;
  lineDescriptions: string[];
  confidence: number;
  warnings: string[];
  rawText: string;
};

export type GlSuggestion = {
  glCode: string;
  description: string;
  score: number;
  reasons: string[];
};

export type InvoiceGlLine = {
  glCode: string;
  description: string;
  amount: number | null;
  confidence: number;
  source: "ai" | "rule" | "vendor_history" | "manual";
};

export type StampPlacement = {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type InvoiceRecord = {
  id: string;
  originalName: string;
  uploadedAt: string;
  status: InvoiceStatus;
  extraction: InvoiceExtraction;
  glSuggestions: GlSuggestion[];
  glLines: InvoiceGlLine[];
  stampPlacement: StampPlacement;
  finalFileName?: string;
  finalizedAt?: string;
  driveFileId?: string;
  driveFileName?: string;
  driveWebViewLink?: string;
  driveUploadedAt?: string;
  driveUploadError?: string;
  warnings: string[];
  error?: string;
};

export type StampSettings = {
  gmInitials: string;
  autoConfidenceThreshold: number;
  googleDriveFolderId: string;
  uploadFinalizedToDrive: boolean;
};

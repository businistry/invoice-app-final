import fs from "node:fs";
import path from "node:path";

export function sanitizeFilenamePart(value: string | null | undefined, fallback: string): string {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || fallback;
}

export function buildFinalPdfName(vendorName: string, invoiceNumber: string): string {
  const vendor = sanitizeFilenamePart(vendorName, "Unknown Vendor");
  const invoice = sanitizeFilenamePart(invoiceNumber, "Unknown Invoice");
  return `STLMO_${vendor}_${invoice}.pdf`;
}

export function uniqueFilePath(directory: string, desiredFileName: string): { fileName: string; fullPath: string } {
  const parsed = path.parse(desiredFileName);
  let candidate = desiredFileName;
  let index = 2;

  while (fs.existsSync(path.join(directory, candidate))) {
    candidate = `${parsed.name}_${index}${parsed.ext}`;
    index += 1;
  }

  return {
    fileName: candidate,
    fullPath: path.join(directory, candidate)
  };
}

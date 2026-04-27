import OpenAI from "openai";
import type { InvoiceExtraction } from "./types";

const INVOICE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "vendorName",
    "invoiceNumber",
    "invoiceDate",
    "totalAmount",
    "lineDescriptions",
    "confidence",
    "warnings",
    "rawText"
  ],
  properties: {
    vendorName: { type: "string" },
    invoiceNumber: { type: "string" },
    invoiceDate: { type: "string" },
    totalAmount: { anyOf: [{ type: "number" }, { type: "null" }] },
    lineDescriptions: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    warnings: { type: "array", items: { type: "string" } },
    rawText: { type: "string" }
  }
};

function getResponseText(response: unknown): string {
  const typed = response as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
  };

  if (typed.output_text) return typed.output_text;

  return (
    typed.output
      ?.flatMap((item) => item.content || [])
      .map((content) => content.text || "")
      .join("\n")
      .trim() || ""
  );
}

function parseAmountFromName(fileName: string): number | null {
  const labeledAmount = fileName.match(/(?:amount|total)[\s_-]*\$?(\d{1,6}(?:[.,]\d{2})?)/i);
  const decimalAmounts = [...fileName.matchAll(/\$?(\d{1,6}[.,]\d{2})/g)];
  const amountMatch = labeledAmount?.[1] || decimalAmounts.at(-1)?.[1];
  if (!amountMatch) return null;
  const value = Number(amountMatch.replace(",", ""));
  return Number.isFinite(value) ? value : null;
}

function fallbackExtraction(fileName: string): InvoiceExtraction {
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const parts = baseName.split(/[_-]+/).map((part) => part.trim()).filter(Boolean);
  const invoiceNumber = parts.find((part) => /(?:inv|invoice)?\d{3,}/i.test(part)) || "";
  const vendorName = parts.filter((part) => part !== invoiceNumber && !/^\$?\d/.test(part)).join(" ");

  return {
    vendorName,
    invoiceNumber,
    invoiceDate: "",
    totalAmount: parseAmountFromName(fileName),
    lineDescriptions: parts,
    confidence: 0.28,
    warnings: ["AI extraction is not configured. Set OPENAI_API_KEY for scanned and digital PDF understanding."],
    rawText: baseName
  };
}

export async function extractInvoiceFromPdf(buffer: Buffer, fileName: string): Promise<InvoiceExtraction> {
  if (!process.env.OPENAI_API_KEY) {
    return fallbackExtraction(fileName);
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-5-mini";
    const response = await client.responses.create({
      model,
      input: [
        {
          role: "system",
          content:
            "Extract invoice fields for an approval workflow. Return only data visible in the invoice. Use an empty string or null when a field is missing."
        },
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: fileName,
              file_data: `data:application/pdf;base64,${buffer.toString("base64")}`
            },
            {
              type: "input_text",
              text:
                "Extract vendor name, invoice number, invoice date, total amount, line item descriptions, confidence, warnings, and concise raw text useful for GL matching."
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "invoice_extraction",
          strict: true,
          schema: INVOICE_SCHEMA
        }
      }
    } as never);

    const text = getResponseText(response);
    const parsed = JSON.parse(text) as InvoiceExtraction;

    return {
      vendorName: parsed.vendorName || "",
      invoiceNumber: parsed.invoiceNumber || "",
      invoiceDate: parsed.invoiceDate || "",
      totalAmount: typeof parsed.totalAmount === "number" ? parsed.totalAmount : null,
      lineDescriptions: Array.isArray(parsed.lineDescriptions) ? parsed.lineDescriptions : [],
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0))),
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      rawText: parsed.rawText || ""
    };
  } catch (error) {
    const fallback = fallbackExtraction(fileName);
    fallback.warnings.unshift(`AI extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    return fallback;
  }
}

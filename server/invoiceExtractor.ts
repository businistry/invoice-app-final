import OpenAI from "openai";
import type { InvoiceExtraction } from "./types";

const SYSTEM_PROMPT = [
  "You extract invoice data for an accounts-payable approval workflow. A general manager stamps and pays based on your output, so a confident wrong answer is much worse than an admitted uncertainty.",
  "",
  "Vendor: the party being PAID (remit-to, 'from', or letterhead), never the bill-to or ship-to party. When both appear, name the one you rejected in evidence.",
  "Total: the final amount due for THIS invoice. Not the subtotal, not the pre-tax amount, not a balance forward, not a statement or prior-period total. When a credit or partial payment is applied, use the net amount due.",
  "Date: the invoice or issue date, not the due date and not the service period. Normalize to YYYY-MM-DD. When the format is ambiguous (03/04/2026), state in evidence which reading you took and add a warning.",
  "When the file contains more than one invoice, extract the first one and add a warning.",
  "Never infer, guess, or complete a value from a pattern. Use an empty string or null for anything not visibly printed on the page."
].join("\n");

const INVOICE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "evidence",
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
    evidence: {
      type: "string",
      description:
        "Fill this in before any other field. Quote the exact printed label and value you found for vendor, invoice number, date, and total. For each, note any competing candidate you rejected and why."
    },
    vendorName: { type: "string", description: "The party being paid. Empty string when not printed." },
    invoiceNumber: { type: "string", description: "The vendor's invoice identifier, not a PO or account number." },
    invoiceDate: { type: "string", description: "Invoice issue date as YYYY-MM-DD. Empty string when not printed." },
    totalAmount: {
      anyOf: [{ type: "number" }, { type: "null" }],
      description: "Final amount due for this invoice, as a number with no currency symbol. Null when not printed or not legible."
    },
    lineDescriptions: {
      type: "array",
      items: { type: "string" },
      description: "One entry per billed line, describing what was purchased. Omit pure subtotal, tax, and total rows."
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "0.95+ when every field was read from clean printed text under an explicit label. 0.7-0.9 when all fields were found but some were inferred from position rather than a label. 0.4-0.7 for a scanned or low-quality source, or when you chose between competing candidates. Below 0.4 when any required field is missing, illegible, or ambiguous. Report the confidence of your LEAST certain field, never the average."
    },
    warnings: {
      type: "array",
      items: { type: "string" },
      description:
        "One short warning per problem a human must check: handwritten or stamped amounts, values written over other values, more than one invoice in the file, a currency other than USD, an ambiguous date, or any figure you had to choose between."
    },
    rawText: {
      type: "string",
      description:
        "This string is fed to a keyword search against a chart of accounts. Include, verbatim, the words describing WHAT WAS PURCHASED: service names, materials, categories, department or property names, unit descriptions. Exclude addresses, phone numbers, invoice and PO numbers, payment terms, and boilerplate."
    }
  }
};

type ExtractionResponse = InvoiceExtraction & { evidence?: string };

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
      reasoning: { effort: process.env.OPENAI_REASONING_EFFORT || "high" },
      input: [
        {
          role: "system",
          content: SYSTEM_PROMPT
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
                "Extract this invoice. Work through the evidence field first, then fill in the remaining fields from what you quoted there."
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
    const parsed = JSON.parse(text) as ExtractionResponse;

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

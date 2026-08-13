import OpenAI from "openai";
import type { GlCode, GlSuggestion, InvoiceExtraction, InvoiceRecord } from "./types";

const MAX_CHART_CODES = Number(process.env.GL_AI_MAX_CODES || 400);

const SYSTEM_PROMPT = [
  "You assign general ledger codes to an invoice for an accounts-payable approval workflow. A general manager reviews your suggestions before payment, so an honest low score is far more useful than a confident wrong code.",
  "",
  "Choose only from the chart of accounts provided. Never invent a code and never adapt one that is close.",
  "Code by the NATURE OF THE EXPENSE (what was purchased), not by who the vendor is. The same vendor can bill to different accounts on different invoices.",
  "Prefer the most specific account that fully covers the expense. Fall back to a general account only when no specific one applies.",
  "Prior codes for this vendor are history, not instruction. Follow them when this invoice is the same kind of purchase, and depart from them when it is not, saying so in your reason.",
  "When the invoice describes several different kinds of expense, return one suggestion per kind, highest amount first.",
  "When nothing in the chart genuinely fits, return an empty list rather than the closest wrong answer."
].join("\n");

const SUGGESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reading", "suggestions"],
  properties: {
    reading: {
      type: "string",
      description:
        "Fill this in first. State in one or two sentences what this invoice actually purchased, in your own words, based on the line descriptions and text. Do not name any GL code here."
    },
    suggestions: {
      type: "array",
      description: "Up to 3 candidate accounts, best first. Empty when no account in the chart genuinely fits.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["glCode", "score", "reason", "rejected"],
        properties: {
          glCode: { type: "string", description: "A code copied exactly from the chart of accounts provided." },
          score: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description:
              "0.9+ when the account description directly names this expense. 0.6-0.9 when the fit is clear by category but not named. 0.3-0.6 when you are choosing between plausible accounts. Below 0.3 when you are mostly guessing."
          },
          reason: {
            type: "string",
            description: "One sentence, naming the words on the invoice that drove the choice. Written for a GM who will verify it in seconds."
          },
          rejected: {
            type: "string",
            description: "The strongest account you considered and did not choose, and why. Empty string when there was no close second."
          }
        }
      }
    }
  }
};

type AiSuggestionResponse = {
  reading?: string;
  suggestions?: Array<{ glCode?: string; score?: number; reason?: string; rejected?: string }>;
};

function getResponseText(response: unknown): string {
  const typed = response as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
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

function chartOfAccounts(glCodes: GlCode[]): string {
  return glCodes
    .filter((code) => code.active)
    .slice(0, MAX_CHART_CODES)
    .map((code) => {
      const keywords = code.keywords.slice(0, 8).join(", ");
      return keywords ? `${code.code} | ${code.description} | ${keywords}` : `${code.code} | ${code.description}`;
    })
    .join("\n");
}

function vendorHistory(extraction: InvoiceExtraction, invoices: InvoiceRecord[]): string {
  const vendor = extraction.vendorName.trim().toLowerCase();
  if (!vendor) return "";

  const priorCodes = new Map<string, number>();
  invoices
    .filter(
      (record) =>
        ["finalized", "auto_finalized"].includes(record.status) &&
        record.extraction.vendorName.trim().toLowerCase() === vendor
    )
    .slice(0, 20)
    .forEach((record) => {
      record.glLines.forEach((line) => {
        if (!line.glCode) return;
        priorCodes.set(line.glCode, (priorCodes.get(line.glCode) || 0) + 1);
      });
    });

  if (priorCodes.size === 0) return "";

  const summary = [...priorCodes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `${code} (used ${count}x)`)
    .join(", ");

  return `Previously approved codes for ${extraction.vendorName}: ${summary}`;
}

function invoiceSummary(extraction: InvoiceExtraction): string {
  return [
    `Vendor: ${extraction.vendorName || "(unknown)"}`,
    `Invoice number: ${extraction.invoiceNumber || "(unknown)"}`,
    `Date: ${extraction.invoiceDate || "(unknown)"}`,
    `Total: ${typeof extraction.totalAmount === "number" ? extraction.totalAmount : "(unknown)"}`,
    "Line descriptions:",
    ...(extraction.lineDescriptions.length > 0
      ? extraction.lineDescriptions.map((line) => `  - ${line}`)
      : ["  (none extracted)"]),
    "",
    "Invoice text:",
    extraction.rawText || "(none extracted)"
  ].join("\n");
}

/**
 * Never throws. A failure here must not take down an invoice upload, so the
 * caller falls back to keyword matching alone.
 */
export async function suggestGlCodesWithAi(
  extraction: InvoiceExtraction,
  glCodes: GlCode[],
  invoices: InvoiceRecord[] = []
): Promise<GlSuggestion[]> {
  try {
    return await requestGlCodes(extraction, glCodes, invoices);
  } catch {
    return [];
  }
}

async function requestGlCodes(
  extraction: InvoiceExtraction,
  glCodes: GlCode[],
  invoices: InvoiceRecord[]
): Promise<GlSuggestion[]> {
  const activeCodes = glCodes.filter((code) => code.active);
  if (!process.env.OPENAI_API_KEY || activeCodes.length === 0) return [];

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_GL_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const history = vendorHistory(extraction, invoices);

  const response = await client.responses.create({
    model,
    reasoning: { effort: process.env.OPENAI_REASONING_EFFORT || "high" },
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          "CHART OF ACCOUNTS (code | description | keywords):",
          chartOfAccounts(activeCodes),
          "",
          "INVOICE:",
          invoiceSummary(extraction),
          ...(history ? ["", "VENDOR HISTORY:", history] : [])
        ].join("\n")
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "gl_suggestions",
        strict: true,
        schema: SUGGESTION_SCHEMA
      }
    }
  } as never);

  const parsed = JSON.parse(getResponseText(response)) as AiSuggestionResponse;
  const byCode = new Map(activeCodes.map((code) => [code.code, code]));

  return (parsed.suggestions || [])
    .map((suggestion) => {
      const code = byCode.get(String(suggestion.glCode || "").trim());
      if (!code) return null;

      const reasons = [suggestion.reason, suggestion.rejected ? `considered instead: ${suggestion.rejected}` : ""]
        .map((reason) => String(reason || "").trim())
        .filter(Boolean);

      return {
        glCode: code.code,
        description: code.description,
        score: Number(Math.min(Math.max(Number(suggestion.score || 0), 0), 1).toFixed(2)),
        reasons
      };
    })
    .filter((suggestion): suggestion is GlSuggestion => suggestion !== null && suggestion.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

/**
 * True only when both engines independently put the same code first. Used to
 * gate auto-finalization: a keyword hit the model disagrees with is exactly the
 * case a human should look at.
 */
export function enginesAgree(ruleSuggestions: GlSuggestion[], aiSuggestions: GlSuggestion[]): boolean {
  const topRule = ruleSuggestions[0]?.glCode;
  const topAi = aiSuggestions[0]?.glCode;
  return Boolean(topRule && topAi && topRule === topAi);
}

export function blendSuggestions(ruleSuggestions: GlSuggestion[], aiSuggestions: GlSuggestion[]): GlSuggestion[] {
  const merged = new Map<string, GlSuggestion>();

  aiSuggestions.forEach((suggestion) => {
    merged.set(suggestion.glCode, { ...suggestion, reasons: suggestion.reasons.map((reason) => `AI: ${reason}`) });
  });

  ruleSuggestions.forEach((suggestion) => {
    const existing = merged.get(suggestion.glCode);
    if (!existing) {
      merged.set(suggestion.glCode, suggestion);
      return;
    }

    merged.set(suggestion.glCode, {
      ...existing,
      score: Number(Math.min(1, Math.max(existing.score, suggestion.score) + 0.1).toFixed(2)),
      reasons: [...existing.reasons, "keyword match agrees", ...suggestion.reasons]
    });
  });

  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}

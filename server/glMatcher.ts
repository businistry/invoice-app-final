import type { GlCode, GlSuggestion, InvoiceExtraction, InvoiceRecord } from "./types";

const STOP_WORDS = new Set([
  "and",
  "any",
  "are",
  "for",
  "from",
  "has",
  "into",
  "other",
  "that",
  "the",
  "this",
  "used",
  "with",
  "your"
]);

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(" ")
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
  );
}

function vendorHistoryBoost(
  invoice: InvoiceExtraction,
  invoices: InvoiceRecord[],
  code: string
): { boost: number; reason?: string } {
  const vendor = normalize(invoice.vendorName);
  if (!vendor) return { boost: 0 };

  const priorMatches = invoices.filter(
    (record) =>
      ["finalized", "auto_finalized"].includes(record.status) &&
      normalize(record.extraction.vendorName) === vendor &&
      record.glLines.some((line) => line.glCode === code)
  );

  if (priorMatches.length === 0) return { boost: 0 };
  return { boost: Math.min(0.35, priorMatches.length * 0.12), reason: "vendor history" };
}

export function matchGlCodes(
  extraction: InvoiceExtraction,
  glCodes: GlCode[],
  invoices: InvoiceRecord[] = []
): GlSuggestion[] {
  const searchText = normalize(
    [
      extraction.vendorName,
      extraction.invoiceNumber,
      extraction.lineDescriptions.join(" "),
      extraction.rawText
    ].join(" ")
  );
  const invoiceTokens = tokenSet(searchText);

  return glCodes
    .filter((code) => code.active)
    .map((code) => {
      let score = 0;
      const reasons: string[] = [];
      const description = normalize(code.description);
      const descriptionTokens = tokenSet(code.description);

      if (description && searchText.includes(description)) {
        score += 0.35;
        reasons.push("description phrase");
      }

      const overlappingDescriptionTokens = [...descriptionTokens].filter((token) => invoiceTokens.has(token));
      if (overlappingDescriptionTokens.length > 0) {
        score += Math.min(0.3, overlappingDescriptionTokens.length * 0.06);
        reasons.push(`description words: ${overlappingDescriptionTokens.slice(0, 3).join(", ")}`);
      }

      code.keywords.forEach((keyword) => {
        const normalizedKeyword = normalize(keyword);
        if (!normalizedKeyword) return;

        if (searchText.includes(normalizedKeyword)) {
          score += normalizedKeyword.split(" ").length > 1 ? 0.28 : 0.18;
          reasons.push(`keyword: ${keyword}`);
        } else {
          const keywordTokens = tokenSet(keyword);
          const overlap = [...keywordTokens].filter((token) => invoiceTokens.has(token));
          if (overlap.length > 0) {
            score += Math.min(0.16, overlap.length * 0.05);
            reasons.push(`keyword words: ${overlap.slice(0, 2).join(", ")}`);
          }
        }
      });

      const history = vendorHistoryBoost(extraction, invoices, code.code);
      score += history.boost;
      if (history.reason) reasons.push(history.reason);

      return {
        glCode: code.code,
        description: code.description,
        score: Number(Math.min(score, 1).toFixed(2)),
        reasons
      };
    })
    .filter((suggestion) => suggestion.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchGlCodes } from "../server/glMatcher";
import type { GlCode, InvoiceExtraction } from "../server/types";

const codes: GlCode[] = [
  {
    id: "1",
    code: "43050",
    description: "Cleaning & Janitorial Supplies",
    keywords: ["Trash Bags", "Ecolab cleaning chemicals"],
    rawKeywords: "Trash Bags, Ecolab cleaning chemicals",
    active: true
  },
  {
    id: "2",
    code: "43100",
    description: "Complimentary Breakfast",
    keywords: ["eggs", "waffles"],
    rawKeywords: "eggs, waffles",
    active: true
  }
];

describe("matchGlCodes", () => {
  it("matches invoice text to keyword-backed GL codes", () => {
    const extraction: InvoiceExtraction = {
      vendorName: "Ecolab",
      invoiceNumber: "1001",
      invoiceDate: "2026-04-26",
      totalAmount: 220,
      lineDescriptions: ["cleaning chemicals and trash bags"],
      confidence: 0.9,
      warnings: [],
      rawText: "invoice for cleaning chemicals and trash bags"
    };

    const matches = matchGlCodes(extraction, codes);
    assert.equal(matches[0].glCode, "43050");
    assert.equal(matches[0].score > 0.4, true);
  });
});

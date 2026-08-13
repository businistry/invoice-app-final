import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blendSuggestions, enginesAgree, suggestGlCodesWithAi } from "../server/glSuggesterAi";
import type { GlCode, GlSuggestion, InvoiceExtraction } from "../server/types";

const ruleHit: GlSuggestion = {
  glCode: "113400",
  description: "HVAC Repairs",
  score: 0.52,
  reasons: ["keyword: HVAC"]
};

const aiHit: GlSuggestion = {
  glCode: "113400",
  description: "HVAC Repairs",
  score: 0.91,
  reasons: ["Invoice bills a compressor replacement on a rooftop unit"]
};

const aiOther: GlSuggestion = {
  glCode: "42050",
  description: "Casual Labor",
  score: 0.4,
  reasons: ["Line mentions contract labor hours"]
};

describe("blendSuggestions", () => {
  it("boosts a code both engines picked and keeps it first", () => {
    const blended = blendSuggestions([ruleHit], [aiHit]);
    assert.equal(blended[0].glCode, "113400");
    assert.equal(blended[0].score > aiHit.score, true);
    assert.equal(
      blended[0].reasons.some((reason) => reason.includes("keyword match agrees")),
      true
    );
  });

  it("never lets a blended score exceed 1", () => {
    const blended = blendSuggestions([{ ...ruleHit, score: 1 }], [{ ...aiHit, score: 1 }]);
    assert.equal(blended[0].score <= 1, true);
  });

  it("keeps codes only one engine found", () => {
    const blended = blendSuggestions([ruleHit], [aiOther]);
    const codes = blended.map((suggestion) => suggestion.glCode).sort();
    assert.deepEqual(codes, ["113400", "42050"]);
  });

  it("returns rule suggestions unchanged when the model produced nothing", () => {
    const blended = blendSuggestions([ruleHit], []);
    assert.deepEqual(blended, [ruleHit]);
  });

  it("caps the blended list at eight entries", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      glCode: `1130${index}`,
      description: `Code ${index}`,
      score: 0.5,
      reasons: []
    }));
    assert.equal(blendSuggestions(many, []).length, 8);
  });
});

describe("enginesAgree", () => {
  it("is true only when both engines put the same code first", () => {
    assert.equal(enginesAgree([ruleHit], [aiHit]), true);
    assert.equal(enginesAgree([ruleHit], [aiOther]), false);
  });

  it("is false when either engine returned nothing", () => {
    assert.equal(enginesAgree([], [aiHit]), false);
    assert.equal(enginesAgree([ruleHit], []), false);
    assert.equal(enginesAgree([], []), false);
  });
});

describe("suggestGlCodesWithAi", () => {
  const extraction: InvoiceExtraction = {
    vendorName: "Cardinal Mechanical",
    invoiceNumber: "CMS-1",
    invoiceDate: "2026-07-28",
    totalAmount: 842.5,
    lineDescriptions: ["HVAC compressor replacement"],
    confidence: 0.8,
    warnings: [],
    rawText: "HVAC compressor rooftop"
  };

  const codes: GlCode[] = [
    {
      id: "1",
      code: "113400",
      description: "HVAC Repairs",
      keywords: [],
      rawKeywords: "",
      active: true
    }
  ];

  it("returns nothing when no API key is configured", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      assert.deepEqual(await suggestGlCodesWithAi(extraction, codes), []);
    } finally {
      if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
    }
  });

  it("returns nothing when the chart of accounts is empty", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key-not-used";
    try {
      assert.deepEqual(await suggestGlCodesWithAi(extraction, []), []);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
});

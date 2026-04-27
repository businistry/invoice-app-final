import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGlFile } from "../server/glImport";

describe("parseGlFile", () => {
  it("imports valid GL rows and skips invalid #VALUE rows", async () => {
    const csv = Buffer.from(
      [
        "GL Code,Description,Keywords",
        "42050,Casual Labor,contract/temp labor",
        ",#VALUE!,",
        "43050,Cleaning & Janitorial Supplies,\"Trash Bags, chemicals\""
      ].join("\n")
    );

    const result = await parseGlFile(csv, "gl.csv");

    assert.equal(result.codes.length, 2);
    assert.equal(result.codes[0].code, "42050");
    assert.equal(result.codes[1].keywords.includes("Trash Bags"), true);
    assert.equal(result.skippedRows.length, 1);
    assert.equal(result.skippedRows[0].rowNumber, 3);
  });
});

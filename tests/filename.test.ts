import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildFinalPdfName, sanitizeFilenamePart, uniqueFilePath } from "../server/filename";

let tempDir = "";

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("filename helpers", () => {
  it("sanitizes vendor and invoice values", () => {
    assert.equal(sanitizeFilenamePart("Vendor: / Name", "Fallback"), "Vendor Name");
    assert.equal(buildFinalPdfName("Acme / Supply", "INV:1001"), "STLMO_Acme Supply_INV 1001.pdf");
  });

  it("adds duplicate suffixes", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "invoice-file-"));
    fs.writeFileSync(path.join(tempDir, "STLMO_Acme_100.pdf"), "one");
    fs.writeFileSync(path.join(tempDir, "STLMO_Acme_100_2.pdf"), "two");

    assert.equal(uniqueFilePath(tempDir, "STLMO_Acme_100.pdf").fileName, "STLMO_Acme_100_3.pdf");
  });
});

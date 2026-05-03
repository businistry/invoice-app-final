import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeGoogleDriveFolderId } from "../server/googleDrive";

describe("Google Drive helpers", () => {
  it("accepts folder IDs and folder URLs", () => {
    assert.equal(normalizeGoogleDriveFolderId("abc123_folder-Id"), "abc123_folder-Id");
    assert.equal(
      normalizeGoogleDriveFolderId("https://drive.google.com/drive/folders/abc123_folder-Id?usp=sharing"),
      "abc123_folder-Id"
    );
  });
});

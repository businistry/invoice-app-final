import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPendingInvoice, nextPendingInvoiceId } from "../src/invoiceQueue";

const sent = "2026-01-01T00:00:00.000Z";

describe("Drive processing queue", () => {
  it("keeps invoices pending until a Drive upload is confirmed", () => {
    assert.equal(isPendingInvoice({}), true);
    assert.equal(isPendingInvoice({ driveUploadedAt: sent }), false);
  });

  it("selects the first unsent invoice when opening or refreshing the app", () => {
    assert.equal(nextPendingInvoiceId([
      { id: "done", driveUploadedAt: sent },
      { id: "pending" }
    ]), "pending");
  });

  it("advances in list order, skipping invoices already sent", () => {
    assert.equal(nextPendingInvoiceId([
      { id: "earlier" },
      { id: "current", driveUploadedAt: sent },
      { id: "done", driveUploadedAt: sent },
      { id: "next" }
    ], "current"), "next");
  });

  it("wraps to an earlier unsent invoice after reaching the end", () => {
    assert.equal(nextPendingInvoiceId([
      { id: "earlier" },
      { id: "current", driveUploadedAt: sent }
    ], "current"), "earlier");
  });

  it("does not reselect the completed invoice", () => {
    assert.equal(nextPendingInvoiceId([{ id: "current", driveUploadedAt: sent }], "current"), "");
  });

  it("handles an empty queue and a current invoice no longer in the list", () => {
    assert.equal(nextPendingInvoiceId([]), "");
    assert.equal(nextPendingInvoiceId([{ id: "pending" }], "removed"), "pending");
  });
});

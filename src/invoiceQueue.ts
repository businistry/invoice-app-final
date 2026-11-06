import type { InvoiceRecord } from "./types";

type QueueInvoice = Pick<InvoiceRecord, "id" | "driveUploadedAt">;

export function isPendingInvoice(invoice: Pick<InvoiceRecord, "driveUploadedAt">): boolean {
  return !invoice.driveUploadedAt;
}

export function nextPendingInvoiceId(invoices: readonly QueueInvoice[], currentId?: string): string {
  const index = invoices.findIndex((invoice) => invoice.id === currentId);
  const ordered = [...invoices.slice(index + 1), ...invoices.slice(0, index + 1)];
  return ordered.find((invoice) => invoice.id !== currentId && isPendingInvoice(invoice))?.id || "";
}

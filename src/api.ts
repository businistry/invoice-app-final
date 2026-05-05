import type { GlCode, GlImportReport, InvoiceRecord, StampSettings } from "./types";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Request failed: ${response.status}`;
    throw new ApiError(message, response.status, body);
  }
  return body as T;
}

export function fetchConfig(): Promise<{
  settings: StampSettings;
  hasOpenAiKey: boolean;
  hasGoogleDriveCredentials: boolean;
  googleDriveServiceAccountEmail: string;
  hasGoogleDriveOAuthCredentials: boolean;
  hasGoogleDriveOAuthToken: boolean;
  googleDriveAuthUrl: string;
}> {
  return request("/api/config");
}

export function fetchInvoices(): Promise<{ invoices: InvoiceRecord[] }> {
  return request("/api/invoices");
}

export function uploadInvoices(files: FileList): Promise<{ invoices: InvoiceRecord[] }> {
  const form = new FormData();
  Array.from(files).forEach((file) => form.append("files", file));
  return request("/api/invoices/upload", { method: "POST", body: form });
}

export function updateInvoice(invoice: InvoiceRecord): Promise<InvoiceRecord> {
  return request(`/api/invoices/${invoice.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      extraction: invoice.extraction,
      glLines: invoice.glLines,
      stampPlacement: invoice.stampPlacement
    })
  });
}

export function finalizeInvoice(id: string): Promise<InvoiceRecord> {
  return request(`/api/invoices/${id}/finalize`, { method: "POST" });
}

export function sendInvoiceToDrive(id: string): Promise<InvoiceRecord> {
  return request(`/api/invoices/${id}/send-to-drive`, { method: "POST" });
}

export function deleteInvoice(id: string): Promise<{ deletedId: string }> {
  return request(`/api/invoices/${id}`, { method: "DELETE" });
}

export function clearAllInvoices(): Promise<{ cleared: number }> {
  return request("/api/invoices", { method: "DELETE" });
}

export function fetchGlCodes(): Promise<{ glCodes: GlCode[]; importReports: GlImportReport[] }> {
  return request("/api/gl-codes");
}

export function importGlCodes(file: File): Promise<{ glCodes: GlCode[]; report: GlImportReport }> {
  const form = new FormData();
  form.append("file", file);
  return request("/api/gl-codes/import", { method: "POST", body: form });
}

export function saveStampSettings(settings: StampSettings): Promise<StampSettings> {
  return request("/api/settings/stamp", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings)
  });
}

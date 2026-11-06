import {
  Activity,
  BadgeCheck,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  Clock3,
  CloudUpload,
  Command,
  Download,
  ExternalLink,
  FileStack,
  FileText,
  Gauge,
  Loader2,
  ReceiptText,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Table2,
  Trash2,
  UploadCloud,
  Wand2
} from "lucide-react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { ChangeEvent, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ApiError,
  clearAllInvoices,
  deleteInvoice,
  fetchConfig,
  fetchGlCodes,
  fetchInvoices,
  finalizeInvoice,
  importGlCodes,
  saveStampSettings,
  sendInvoiceToDrive,
  updateInvoice,
  uploadInvoices
} from "./api";
import { isPendingInvoice, nextPendingInvoiceId } from "./invoiceQueue";
import type { GlCode, GlImportReport, InvoiceGlLine, InvoiceRecord, StampSettings } from "./types";

type View = "queue" | "gl" | "settings";
type InvoiceFilter = "all" | "pending" | "finalized";
type PageRenderInfo = { width: number; height: number; scale: number };

GlobalWorkerOptions.workerSrc = pdfWorker;

const emptySettings: StampSettings = {
  gmInitials: "TC",
  autoConfidenceThreshold: 0.72,
  googleDriveFolderId: "",
  uploadFinalizedToDrive: false
};

function formatMoney(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function statusLabel(status: string): string {
  return status.replace("_", " ");
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0%";
  return `${Math.round(value * 100)}%`;
}

function cloneInvoice(invoice: InvoiceRecord): InvoiceRecord {
  return JSON.parse(JSON.stringify(invoice)) as InvoiceRecord;
}

function sumLines(lines: InvoiceGlLine[]): number {
  return Number(lines.reduce((sum, line) => sum + Number(line.amount || 0), 0).toFixed(2));
}

function activeGlLines(lines: InvoiceGlLine[]): InvoiceGlLine[] {
  return lines.filter((line) => line.glCode.trim() || typeof line.amount === "number");
}

function validationWarningsForDraft(invoice: InvoiceRecord): string[] {
  const warnings: string[] = [];
  const stampLines = activeGlLines(invoice.glLines);
  if (!invoice.extraction.vendorName.trim()) warnings.push("Vendor name is missing.");
  if (!invoice.extraction.invoiceNumber.trim()) warnings.push("Invoice number is missing.");
  if (typeof invoice.extraction.totalAmount !== "number" || !Number.isFinite(invoice.extraction.totalAmount)) {
    warnings.push("Invoice total is missing.");
  }
  if (stampLines.length === 0) warnings.push("No GL line is selected.");
  if (stampLines.some((line) => !line.glCode.trim())) warnings.push("Every GL line needs a GL code.");
  if (stampLines.some((line) => typeof line.amount !== "number" || !Number.isFinite(line.amount))) {
    warnings.push("Every GL line needs an amount.");
  }
  if (
    typeof invoice.extraction.totalAmount === "number" &&
    Number.isFinite(invoice.extraction.totalAmount) &&
    sumLines(stampLines) !== Number(invoice.extraction.totalAmount.toFixed(2))
  ) {
    warnings.push("GL line amounts must equal the invoice total.");
  }
  return warnings;
}

function isInvoiceRecord(value: unknown): value is InvoiceRecord {
  return Boolean(
    value &&
      typeof value === "object" &&
      "id" in value &&
      "extraction" in value &&
      "glLines" in value &&
      "warnings" in value
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isFinalizedInvoice(invoice: InvoiceRecord): boolean {
  return Boolean(invoice.finalFileName);
}

function invoicesForFilter(invoices: InvoiceRecord[], filter: InvoiceFilter): InvoiceRecord[] {
  if (filter === "pending") return invoices.filter(isPendingInvoice);
  if (filter === "finalized") return invoices.filter(isFinalizedInvoice);
  return invoices;
}

function App() {
  const [view, setView] = useState<View>("queue");
  const [invoiceFilter, setInvoiceFilter] = useState<InvoiceFilter>("pending");
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [glCodes, setGlCodes] = useState<GlCode[]>([]);
  const [reports, setReports] = useState<GlImportReport[]>([]);
  const [settings, setSettings] = useState<StampSettings>(emptySettings);
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);
  const [hasGoogleDriveCredentials, setHasGoogleDriveCredentials] = useState(false);
  const [googleDriveServiceAccountEmail, setGoogleDriveServiceAccountEmail] = useState("");
  const [hasGoogleDriveOAuthCredentials, setHasGoogleDriveOAuthCredentials] = useState(false);
  const [hasGoogleDriveOAuthToken, setHasGoogleDriveOAuthToken] = useState(false);
  const [googleDriveAuthUrl, setGoogleDriveAuthUrl] = useState("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [draft, setDraft] = useState<InvoiceRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [glSearch, setGlSearch] = useState("");

  async function refresh() {
    const [config, invoiceData, glData] = await Promise.all([fetchConfig(), fetchInvoices(), fetchGlCodes()]);
    setSettings(config.settings);
    setHasOpenAiKey(config.hasOpenAiKey);
    setHasGoogleDriveCredentials(config.hasGoogleDriveCredentials);
    setGoogleDriveServiceAccountEmail(config.googleDriveServiceAccountEmail);
    setHasGoogleDriveOAuthCredentials(config.hasGoogleDriveOAuthCredentials);
    setHasGoogleDriveOAuthToken(config.hasGoogleDriveOAuthToken);
    setGoogleDriveAuthUrl(config.googleDriveAuthUrl);
    setInvoices(invoiceData.invoices);
    setGlCodes(glData.glCodes);
    setReports(glData.importReports);
    if (!selectedId) setSelectedId(nextPendingInvoiceId(invoiceData.invoices));
    return invoiceData.invoices;
  }

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    function load(attempt = 0) {
      refresh().catch((error: unknown) => {
        if (cancelled) return;
        const temporaryFailure = error instanceof TypeError || (error instanceof ApiError && error.status >= 500);
        if (temporaryFailure && attempt < 8) {
          retryTimer = setTimeout(() => load(attempt + 1), 500);
        } else {
          setMessage(error instanceof Error ? error.message : "Could not load invoice data.");
        }
      });
    }
    load();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    const selected = invoices.find((invoice) => invoice.id === selectedId);
    setDraft(selected ? cloneInvoice(selected) : null);
  }, [selectedId, invoices]);

  const queueInvoices = invoices.filter(isPendingInvoice);
  const finalizedInvoices = invoices.filter(isFinalizedInvoice);
  const displayedInvoices = invoicesForFilter(invoices, invoiceFilter);
  const displayedInvoiceCountLabel =
    invoiceFilter === "pending"
      ? `${queueInvoices.length} pending`
      : invoiceFilter === "finalized"
        ? `${finalizedInvoices.length} finalized`
        : `${invoices.length} total`;
  const filteredGlCodes = useMemo(() => {
    const query = glSearch.trim().toLowerCase();
    if (!query) return glCodes;
    return glCodes.filter((code) =>
      [code.code, code.description, code.rawKeywords].join(" ").toLowerCase().includes(query)
    );
  }, [glCodes, glSearch]);

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    if (!event.target.files?.length) return;
    setBusy(true);
    setMessage("Uploading and reading invoices...");
    try {
      const uploaded = await uploadInvoices(event.target.files);
      const latestInvoices = await refresh();
      setInvoiceFilter("pending");
      setView("queue");
      setSelectedId(uploaded.invoices.find(isPendingInvoice)?.id || nextPendingInvoiceId(latestInvoices));
      setMessage(`${uploaded.invoices.length} invoice${uploaded.invoices.length === 1 ? "" : "s"} uploaded.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }

  async function saveDraft(): Promise<InvoiceRecord | null> {
    if (!draft) return null;
    setBusy(true);
    try {
      const saved = await updateInvoice(draft);
      setInvoices((current) => current.map((invoice) => (invoice.id === saved.id ? saved : invoice)));
      setDraft(cloneInvoice(saved));
      setMessage("Invoice saved.");
      return saved;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleFinalize() {
    if (!draft) return;
    setBusy(true);
    setMessage("Stamping PDF...");
    try {
      const saved = await updateInvoice(draft);
      const blockers = validationWarningsForDraft(saved);
      if (blockers.length > 0) {
        setInvoices((current) => current.map((invoice) => (invoice.id === saved.id ? saved : invoice)));
        setDraft(cloneInvoice(saved));
        setMessage(`Cannot finalize yet: ${blockers.join(" ")}`);
        return;
      }

      const finalized = await finalizeInvoice(saved.id);
      setInvoices((current) => current.map((invoice) => (invoice.id === finalized.id ? finalized : invoice)));
      setDraft(cloneInvoice(finalized));
      if (finalized.driveUploadedAt && !finalized.driveUploadError) {
        await advanceAfterDriveUpload(finalized);
        return;
      }
      const driveMessage = finalized.driveUploadError
        ? ` Drive upload needs attention: ${finalized.driveUploadError}`
        : "";
      setMessage(finalized.finalFileName ? `Finalized ${finalized.finalFileName}.${driveMessage}` : "Invoice needs review.");
      setView("queue");
      if (finalized.finalFileName) setInvoiceFilter("finalized");
    } catch (error) {
      if (error instanceof ApiError && isInvoiceRecord(error.body)) {
        const blockedInvoice = error.body;
        setInvoices((current) => current.map((invoice) => (invoice.id === blockedInvoice.id ? blockedInvoice : invoice)));
        setDraft(cloneInvoice(blockedInvoice));
        setMessage(`Cannot finalize yet: ${blockedInvoice.warnings.join(" ")}`);
        return;
      }
      if (error instanceof Error) setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleGlImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const result = await importGlCodes(file);
      setGlCodes(result.glCodes);
      setReports((current) => [result.report, ...current]);
      setMessage(`Imported ${result.report.importedCount} GL codes; skipped ${result.report.skippedRows.length}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "GL import failed");
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }

  async function handleSettingsSave() {
    setBusy(true);
    try {
      const saved = await saveStampSettings(settings);
      setSettings(saved);
      setMessage("Stamp settings saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Settings save failed");
    } finally {
      setBusy(false);
    }
  }

  async function advanceAfterDriveUpload(updated: InvoiceRecord) {
    let latestInvoices = invoices.map((record) => (record.id === updated.id ? updated : record));
    let refreshWarning = "";
    try {
      latestInvoices = (await fetchInvoices()).invoices;
    } catch {
      refreshWarning = " The invoice list could not be refreshed; showing the locally updated queue.";
    }
    const nextId = nextPendingInvoiceId(latestInvoices, updated.id);
    setInvoices(latestInvoices);
    setInvoiceFilter("pending");
    setView("queue");
    setSelectedId(nextId);
    setMessage(
      `Sent ${updated.driveFileName || updated.finalFileName || "PDF"} to Google Drive. ` +
      (nextId ? "Ready for the next invoice." : "All invoices have been sent to Drive.") + refreshWarning
    );
  }

  async function handleSendToDrive(invoice: InvoiceRecord) {
    if (busy) return;
    if (!settings.googleDriveFolderId.trim()) {
      setMessage("Set the Google Drive folder ID in Settings and save it before sending.");
      return;
    }
    const blockers = validationWarningsForDraft(invoice);
    if (blockers.length > 0) {
      setMessage(`Cannot send yet: ${blockers.join(" ")}`);
      return;
    }
    setBusy(true);
    setMessage("Preparing PDF for Google Drive...");
    try {
      const saved = await updateInvoice(invoice);
      const savedBlockers = validationWarningsForDraft(saved);
      setInvoices((current) => current.map((record) => (record.id === saved.id ? saved : record)));
      setDraft(cloneInvoice(saved));
      if (savedBlockers.length > 0) {
        setMessage(`Cannot send yet: ${savedBlockers.join(" ")}`);
        return;
      }
      const prepared = await finalizeInvoice(saved.id);
      setInvoices((current) => current.map((record) => (record.id === prepared.id ? prepared : record)));
      setDraft(cloneInvoice(prepared));
      if (!prepared.finalFileName) {
        setMessage("The invoice must be finalized before it can be sent to Drive.");
        return;
      }
      setMessage("Sending PDF to Google Drive...");
      // Finalization may already have uploaded this version through auto-upload.
      const updated = prepared.driveUploadedAt && !prepared.driveUploadError
        ? prepared
        : await sendInvoiceToDrive(prepared.id);
      setInvoices((current) => current.map((record) => (record.id === updated.id ? updated : record)));
      setDraft(cloneInvoice(updated));
      if (updated.driveUploadError || !updated.driveUploadedAt) {
        setMessage(`Drive upload needs attention: ${updated.driveUploadError || "Upload was not confirmed. Please retry."}`);
        return;
      }
      await advanceAfterDriveUpload(updated);
    } catch (error) {
      if (error instanceof ApiError && isInvoiceRecord(error.body)) {
        const blockedInvoice = error.body;
        setInvoices((current) => current.map((record) => (record.id === blockedInvoice.id ? blockedInvoice : record)));
        setDraft(cloneInvoice(blockedInvoice));
        setMessage(`Cannot send yet: ${blockedInvoice.error || blockedInvoice.warnings.join(" ")}`);
      } else {
        setMessage(error instanceof Error ? error.message : "Google Drive upload failed");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteInvoice(invoice: InvoiceRecord) {
    const fileName = invoice.finalFileName || invoice.originalName;
    if (!window.confirm(`Delete ${fileName}? This removes the invoice record and local PDF files.`)) return;

    setBusy(true);
    try {
      await deleteInvoice(invoice.id);
      const remaining = invoices.filter((record) => record.id !== invoice.id);
      setInvoices(remaining);
      if (selectedId === invoice.id) setSelectedId(invoicesForFilter(remaining, invoiceFilter)[0]?.id || "");
      setMessage(`Deleted ${fileName}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleClearAllInvoices() {
    if (!window.confirm("Clear all invoices and start fresh? This removes every invoice record and its PDF files. GL codes and settings are kept.")) return;

    setBusy(true);
    try {
      const result = await clearAllInvoices();
      setInvoices([]);
      setSelectedId("");
      setDraft(null);
      setMessage(`Cleared ${result.cleared} invoice${result.cleared === 1 ? "" : "s"}. GL codes and settings preserved.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Clear failed");
    } finally {
      setBusy(false);
    }
  }

  function updateDraft(next: Partial<InvoiceRecord>) {
    setDraft((current) => (current ? { ...current, ...next } : current));
  }

  function updateExtraction(field: keyof InvoiceRecord["extraction"], value: string | number | null) {
    setDraft((current) =>
      current
        ? {
            ...current,
            extraction: {
              ...current.extraction,
              [field]: value
            }
          }
        : current
    );
  }

  function updateGlLine(index: number, next: Partial<InvoiceGlLine>) {
    if (!draft) return;
    const lines = [...draft.glLines];
    const current = lines[index] || {
      glCode: "",
      description: "",
      amount: null,
      confidence: 0,
      source: "manual" as const
    };
    lines[index] = { ...current, ...next, source: "manual" };
    updateDraft({ glLines: lines.slice(0, 3) });
  }

  function applyGlSelection(index: number, codeValue: string) {
    const selected = glCodes.find((code) => code.code === codeValue);
    updateGlLine(index, {
      glCode: codeValue,
      description: selected?.description || "",
      confidence: selected ? 0.8 : 0
    });
  }

  function showInvoiceFilter(filter: InvoiceFilter) {
    if (busy) return;
    const nextInvoices = invoicesForFilter(invoices, filter);
    setInvoiceFilter(filter);
    setView("queue");
    setSelectedId(nextInvoices.some((invoice) => invoice.id === selectedId) ? selectedId : nextInvoices[0]?.id || "");
  }

  const activeViewTitle = view === "queue" ? "Invoices" : view === "gl" ? "GL Codes" : "Settings";
  const activeViewSubtitle =
    view === "queue"
      ? "Select an invoice, review its details, and drag the stamp into place."
      : view === "gl"
        ? "Manage the codes used to categorize your invoices."
        : "Set approval initials and upload preferences.";
  const topSuggestion = draft?.glSuggestions[0];
  const draftLineTotal = draft ? sumLines(draft.glLines) : 0;
  const amountBalance =
    draft && typeof draft.extraction.totalAmount === "number"
      ? Number((draft.extraction.totalAmount - draftLineTotal).toFixed(2))
      : null;
  const finalizeBlockers = draft ? validationWarningsForDraft(draft) : [];
  const firstActiveLineIndex = draft ? draft.glLines.findIndex((line) => line.glCode.trim() || typeof line.amount === "number") : -1;
  const canSetSingleLineTotal =
    Boolean(draft) &&
    typeof draft?.extraction.totalAmount === "number" &&
    activeGlLines(draft.glLines).length === 1 &&
    firstActiveLineIndex >= 0 &&
    amountBalance !== 0;

  return (
    <main className="app-shell intelligence-shell">
      <aside className="sidebar command-rail">
        <div className="brand">
          <div className="brand-mark">
            <Command size={22} />
          </div>
          <div>
            <strong>LedgerFlow</strong>
            <span>{hasOpenAiKey ? "AI extraction live" : "manual review mode"}</span>
          </div>
        </div>
        <nav aria-label="Primary workspace">
          <button className={view === "queue" ? "active" : ""} onClick={() => showInvoiceFilter(invoiceFilter)}>
            <ReceiptText size={18} /> Invoices
          </button>
          <button className={view === "gl" ? "active" : ""} onClick={() => setView("gl")}>
            <Table2 size={18} /> GL Codes
          </button>
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
            <Settings size={18} /> Settings
          </button>
        </nav>
      </aside>

      <section className="workspace studio-workspace">
        <header className="topbar command-bar">
          <div>
            <span className="eyebrow">AI invoice approval workspace</span>
            <h1>{activeViewTitle}</h1>
            <p>{activeViewSubtitle}</p>
          </div>
          <div className="topbar-metrics">
            <button
              type="button"
              className={`metric-card ${view === "queue" && invoiceFilter === "pending" ? "active" : ""}`}
              onClick={() => showInvoiceFilter("pending")}
            >
              <Clock3 size={16} />
              <span>{queueInvoices.length}</span>
              <small>pending</small>
            </button>
            <button
              type="button"
              className={`metric-card ${view === "queue" && invoiceFilter === "finalized" ? "active" : ""}`}
              onClick={() => showInvoiceFilter("finalized")}
            >
              <FileStack size={16} />
              <span>{finalizedInvoices.length}</span>
              <small>finalized</small>
            </button>
            <div className="metric-card">
              <Gauge size={16} />
              <span>{glCodes.length}</span>
              <small>GL signals</small>
            </div>
            {busy && <Loader2 className="spin" size={22} />}
          </div>
        </header>

        {message && <div className="notice">{message}</div>}

        {view === "queue" && (
          <section className="queue-layout console-grid">
            <div className="left-column intelligence-queue">
              <div className="panel-title">
                <div>
                  <span>Your documents</span>
                  <h2>Invoices</h2>
                </div>
                <div className="panel-title-actions">
                  <em>{displayedInvoiceCountLabel}</em>
                  {invoices.length > 0 && (
                    <button
                      type="button"
                      className="danger-action clear-all-btn"
                      onClick={handleClearAllInvoices}
                      disabled={busy}
                      title="Clear all invoices and start fresh"
                    >
                      <Trash2 size={14} /> Clear All
                    </button>
                  )}
                </div>
              </div>
              <label className="upload-zone elevated-upload">
                <UploadCloud size={24} />
                <span>Upload invoice PDFs</span>
                <input type="file" accept="application/pdf" multiple onChange={handleUpload} disabled={busy} />
              </label>

              <div className="queue-filters">
                <button
                  type="button"
                  className={invoiceFilter === "all" ? "active-filter" : ""}
                  onClick={() => showInvoiceFilter("all")}
                  aria-pressed={invoiceFilter === "all"}
                >
                  All
                </button>
                <button
                  type="button"
                  className={invoiceFilter === "pending" ? "active-filter" : ""}
                  onClick={() => showInvoiceFilter("pending")}
                  aria-pressed={invoiceFilter === "pending"}
                >
                  Pending
                </button>
                <button
                  type="button"
                  className={invoiceFilter === "finalized" ? "active-filter" : ""}
                  onClick={() => showInvoiceFilter("finalized")}
                  aria-pressed={invoiceFilter === "finalized"}
                >
                  Finalized
                </button>
              </div>

              <div className="invoice-list">
                {displayedInvoices.map((invoice) => (
                  <button
                    key={invoice.id}
                    className={`invoice-row ${selectedId === invoice.id ? "selected" : ""}`}
                    onClick={() => setSelectedId(invoice.id)}
                    disabled={busy}
                  >
                    <span className="doc-chip"><FileText size={15} /></span>
                    <div>
                      <strong>{invoice.extraction.vendorName || invoice.originalName}</strong>
                      <span>{invoice.extraction.invoiceNumber || "No invoice number"} · {formatMoney(invoice.extraction.totalAmount)}</span>
                    </div>
                    <em className={`status ${invoice.status}`}>
                      {invoice.driveUploadedAt ? "sent to Drive" : invoice.finalFileName ? "ready to send" : statusLabel(invoice.status)}
                    </em>
                  </button>
                ))}
                {displayedInvoices.length === 0 && (
                  <div className="list-empty">
                    {invoiceFilter === "pending"
                      ? "No pending invoices."
                      : invoiceFilter === "finalized"
                        ? "No finalized invoices."
                        : "No invoices yet."}
                  </div>
                )}
              </div>
            </div>

            <div className="review-surface approval-grid">
              {draft ? (
                <>
                  <div className="pdf-pane document-stage">
                    <div className="document-toolbar">
                      <div>
                        <span>Source PDF</span>
                        <strong>{draft.originalName}</strong>
                      </div>
                      <div className="document-toolbar-actions">
                        <div className="confidence-pill">
                          <Sparkles size={15} />
                          {formatPercent(draft.extraction.confidence)} extraction
                        </div>
                        <button
                          type="button"
                          className="primary send-drive-button"
                          onClick={() => handleSendToDrive(draft)}
                          disabled={busy || finalizeBlockers.length > 0}
                          title={finalizeBlockers.length > 0 ? finalizeBlockers.join(" ") : "Save, stamp, send to Drive, and open the next pending invoice"}
                        >
                          <CloudUpload size={18} /> {draft.driveUploadedAt ? "Send again to Drive" : "Send to Drive"}
                        </button>
                      </div>
                    </div>
                    <PdfStampPlacementEditor
                      key={draft.id}
                      invoiceId={draft.id}
                      placement={draft.stampPlacement}
                      disabled={busy}
                      onChange={(stampPlacement) => updateDraft({ stampPlacement })}
                    />
                    <div className="document-footer">
                      <span><Bot size={14} /> {topSuggestion ? `${topSuggestion.glCode} suggested` : "Choose a GL code in the review panel"}</span>
                      <span><ShieldCheck size={14} /> {draft.finalFileName ? "Finalized — download the stamped PDF from the review panel" : finalizeBlockers.length === 0 ? "Ready to finalize" : `${finalizeBlockers.length} items to review`}</span>
                    </div>
                  </div>
                  <aside className="review-panel approval-cockpit" inert={busy}>
                    <div className="panel-heading">
                      <div>
                        <span>Invoice details · {statusLabel(draft.status)}</span>
                        <h2>{draft.extraction.vendorName || "Unidentified vendor"}</h2>
                      </div>
                      <BadgeCheck size={22} />
                    </div>
                    {draft.finalFileName && (
                      <p className="finalized-note">This invoice is finalized. Send to Drive saves your latest details and stamp layout before uploading.</p>
                    )}

                    {draft.warnings.length > 0 && (
                      <div className="warning-list">
                        {draft.warnings.map((warning) => (
                          <span key={warning}>{warning}</span>
                        ))}
                      </div>
                    )}

                    <div className="signal-strip">
                      <div className={amountBalance === 0 ? "signal-ok" : "signal-warning"}>
                        <Activity size={16} />
                        <span>Balance</span>
                        <strong>{amountBalance === null ? "Open" : amountBalance === 0 ? "Exact" : formatMoney(amountBalance)}</strong>
                      </div>
                      <div>
                        <CircleDollarSign size={16} />
                        <span>Total</span>
                        <strong>{formatMoney(draft.extraction.totalAmount)}</strong>
                      </div>
                    </div>

                    <section className="extraction-fields">
                      <label>
                        Vendor
                        <input value={draft.extraction.vendorName} onChange={(event) => updateExtraction("vendorName", event.target.value)} />
                      </label>
                      <label>
                        Invoice #
                        <input value={draft.extraction.invoiceNumber} onChange={(event) => updateExtraction("invoiceNumber", event.target.value)} />
                      </label>
                    </section>
                    <div className="field-grid">
                      <label>
                        Date
                        <input value={draft.extraction.invoiceDate} onChange={(event) => updateExtraction("invoiceDate", event.target.value)} />
                      </label>
                      <label>
                        Total
                        <input
                          type="number"
                          step="0.01"
                          value={draft.extraction.totalAmount ?? ""}
                          onChange={(event) => updateExtraction("totalAmount", event.target.value ? Number(event.target.value) : null)}
                        />
                      </label>
                    </div>

                    <div className="suggestions">
                      <h3><Wand2 size={16} /> GL Suggestions</h3>
                      {draft.glSuggestions.slice(0, 3).map((suggestion) => (
                        <button
                          key={suggestion.glCode}
                          onClick={() =>
                            updateDraft({
                              glLines: [
                                {
                                  glCode: suggestion.glCode,
                                  description: suggestion.description,
                                  amount: draft.extraction.totalAmount,
                                  confidence: suggestion.score,
                                  source: "rule"
                                }
                              ]
                            })
                          }
                        >
                          {suggestion.glCode} · {suggestion.description} <span>{Math.round(suggestion.score * 100)}%</span>
                        </button>
                      ))}
                    </div>

                    <div className="split-lines">
                      <h3><ClipboardCheck size={16} /> Coding Lines</h3>
                      {[0, 1, 2].map((index) => (
                        <div className="split-row" key={index}>
                          <select value={draft.glLines[index]?.glCode || ""} onChange={(event) => applyGlSelection(index, event.target.value)}>
                            <option value="">GL code</option>
                            {glCodes.map((code) => (
                              <option key={code.id} value={code.code}>
                                {code.code} · {code.description}
                              </option>
                            ))}
                          </select>
                          <input
                            type="number"
                            step="0.01"
                            placeholder="Amount"
                            value={draft.glLines[index]?.amount ?? ""}
                            onChange={(event) => updateGlLine(index, { amount: event.target.value ? Number(event.target.value) : null })}
                          />
                        </div>
                      ))}
                      <div className="line-total">
                        <span>Line total</span>
                        <strong>{formatMoney(sumLines(draft.glLines))}</strong>
                      </div>
                      {finalizeBlockers.length > 0 && (
                        <div className="validation-card">
                          <strong>Finish these before finalizing</strong>
                          {finalizeBlockers.map((warning) => (
                            <span key={warning}>{warning}</span>
                          ))}
                          {canSetSingleLineTotal && (
                            <button type="button" className="mini-action" onClick={() => updateGlLine(firstActiveLineIndex, { amount: draft.extraction.totalAmount })}>
                              Set GL line to {formatMoney(draft.extraction.totalAmount)}
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="actions">
                      <button onClick={saveDraft} disabled={busy}>Save changes</button>
                      <button className="danger-action" onClick={() => handleDeleteInvoice(draft)} disabled={busy}>
                        <Trash2 size={18} /> Delete PDF
                      </button>
                      <button
                        className="primary"
                        onClick={handleFinalize}
                        disabled={busy || finalizeBlockers.length > 0}
                        title={finalizeBlockers.length > 0 ? finalizeBlockers.join(" ") : undefined}
                      >
                        <CheckCircle2 size={18} /> {draft.finalFileName ? "Finalize again" : "Finalize PDF"}
                      </button>
                    </div>

                    {draft.finalFileName && (
                      <div className="final-file-actions">
                        {draft.finalizedAt && <span className="finalized-note">Finalized {draft.finalizedAt.slice(0, 10)}</span>}
                        {draft.driveUploadedAt && <span className="drive-status">Sent to Google Drive {draft.driveUploadedAt.slice(0, 10)}</span>}
                        <a className="download-link" href={`/api/invoices/${draft.id}/final.pdf`}>
                          <Download size={18} /> {draft.finalFileName}
                        </a>
                        {draft.driveWebViewLink && (
                          <a className="download-link secondary-link" href={draft.driveWebViewLink} target="_blank" rel="noreferrer">
                            <ExternalLink size={18} /> Open in Drive
                          </a>
                        )}
                        {draft.driveUploadError && <div className="drive-error">{draft.driveUploadError}</div>}
                      </div>
                    )}
                  </aside>
                </>
              ) : (
                <div className="empty-state">
                  {invoiceFilter === "pending"
                    ? invoices.length > 0 && queueInvoices.length === 0
                      ? "All invoices have been sent to Drive. Upload more PDFs or open Finalized to view completed invoices."
                      : "Select a pending invoice or upload PDFs to get started."
                    : "No invoice selected."}
                </div>
              )}
            </div>
          </section>
        )}

        {view === "gl" && (
          <section className="gl-surface intelligence-table">
            <div className="toolbar">
              <label className="import-button">
                <UploadCloud size={18} /> Import CSV/XLSX
                <input type="file" accept=".csv,.xlsx,.xls" onChange={handleGlImport} />
              </label>
              <div className="search-box">
                <Search size={18} />
                <input value={glSearch} placeholder="Search GL codes" onChange={(event) => setGlSearch(event.target.value)} />
              </div>
            </div>
            {reports[0] && (
              <div className="notice compact">
                Last import: {reports[0].importedCount} imported, {reports[0].skippedRows.length} skipped.
              </div>
            )}
            <div className="gl-table">
              <div className="gl-header">
                <span>GL Code</span>
                <span>Description</span>
                <span>Keywords</span>
              </div>
              {filteredGlCodes.map((code) => (
                <div className="gl-row" key={code.id}>
                  <strong>{code.code}</strong>
                  <span>{code.description}</span>
                  <span>{code.rawKeywords}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {view === "settings" && (
          <section className="settings-surface controls-surface">
            <label>
              GM Approved Initials
              <input value={settings.gmInitials} onChange={(event) => setSettings({ ...settings, gmInitials: event.target.value })} />
            </label>
            <label>
              Auto-finalize confidence
              <input
                type="number"
                min="0.2"
                max="0.95"
                step="0.01"
                value={settings.autoConfidenceThreshold}
                onChange={(event) => setSettings({ ...settings, autoConfidenceThreshold: Number(event.target.value) })}
              />
            </label>
            <label>
              Google Drive folder ID
              <input
                value={settings.googleDriveFolderId}
                placeholder="Folder ID or folder URL"
                onChange={(event) => setSettings({ ...settings, googleDriveFolderId: event.target.value })}
              />
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={settings.uploadFinalizedToDrive}
                onChange={(event) => setSettings({ ...settings, uploadFinalizedToDrive: event.target.checked })}
              />
              <span>Send finalized PDFs to Drive automatically</span>
            </label>
            {hasGoogleDriveOAuthToken ? (
              <div className="notice compact settings-note">Drive uploads use your connected Google account.</div>
            ) : (
              hasGoogleDriveOAuthCredentials && (
                <a className="download-link settings-connect" href={googleDriveAuthUrl || "/api/google/oauth/start"} target="_blank" rel="noreferrer">
                  <ExternalLink size={18} /> Connect Google Drive
                </a>
              )
            )}
            {googleDriveServiceAccountEmail && !hasGoogleDriveOAuthToken && (
              <div className="notice compact warning-note">
                Service account detected, but regular My Drive folders need OAuth or a shared drive.
              </div>
            )}
            {!hasGoogleDriveOAuthCredentials && !hasGoogleDriveCredentials && (
              <div className="notice compact warning-note">Google Drive credentials are not configured on this server.</div>
            )}
            <button className="primary settings-save" onClick={handleSettingsSave} disabled={busy}>
              Save Settings
            </button>
          </section>
        )}
      </section>
    </main>
  );
}

function PdfStampPlacementEditor({
  invoiceId,
  placement,
  disabled,
  onChange
}: {
  invoiceId: string;
  placement: InvoiceRecord["stampPlacement"];
  disabled: boolean;
  onChange: (placement: InvoiceRecord["stampPlacement"]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{
    startClientX: number;
    startClientY: number;
    startPlacement: InvoiceRecord["stampPlacement"];
  } | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageInfo, setPageInfo] = useState<PageRenderInfo | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const updateWidth = () => setFrameWidth(frame.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPdfDoc(null);
    setPageInfo(null);
    setLoadError("");

    const task = getDocument(`/api/invoices/${invoiceId}/original.pdf`);
    task.promise
      .then((document) => {
        if (!cancelled) setPdfDoc(document);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "PDF preview failed to load.");
      });

    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [invoiceId]);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || frameWidth <= 0) return;

    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    setPageInfo(null);

    async function renderPage() {
      const canvas = canvasRef.current;
      if (!canvas || !pdfDoc) return;

      const pageNumber = clamp(placement.pageIndex + 1, 1, pdfDoc.numPages);
      const page = await pdfDoc.getPage(pageNumber);
      if (cancelled) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(Math.max(frameWidth - 40, 1) / baseViewport.width, 1.5);
      const viewport = page.getViewport({ scale });
      const context = canvas.getContext("2d");
      if (!context) return;

      const outputScale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      context.clearRect(0, 0, canvas.width, canvas.height);

      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
      });
      await renderTask.promise;

      if (!cancelled) {
        setPageInfo({ width: baseViewport.width, height: baseViewport.height, scale });
      }
    }

    void renderPage().catch((error: unknown) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : "PDF preview failed to render.");
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDoc, placement.pageIndex, frameWidth]);

  const normalizedPlacement = (next: InvoiceRecord["stampPlacement"]): InvoiceRecord["stampPlacement"] => {
    if (!pageInfo) return next;
    const width = clamp(next.width, 240, Math.max(240, pageInfo.width - 24));
    const height = clamp(next.height, 84, Math.max(84, pageInfo.height - 24));

    return {
      pageIndex: clamp(next.pageIndex, 0, Math.max((pdfDoc?.numPages || 1) - 1, 0)),
      width,
      height,
      x: clamp(next.x, 12, Math.max(12, pageInfo.width - width - 12)),
      y: clamp(next.y, 12, Math.max(12, pageInfo.height - height - 12))
    };
  };

  function applyPreset(position: "bottom-left" | "bottom-right" | "top-left" | "top-right" | "bottom-center") {
    if (!pageInfo) return;
    const margin = 36;
    const base = normalizedPlacement(placement);
    const xByPosition = {
      "bottom-left": margin,
      "bottom-right": pageInfo.width - base.width - margin,
      "top-left": margin,
      "top-right": pageInfo.width - base.width - margin,
      "bottom-center": (pageInfo.width - base.width) / 2
    };
    const yByPosition = {
      "bottom-left": margin,
      "bottom-right": margin,
      "top-left": pageInfo.height - base.height - margin,
      "top-right": pageInfo.height - base.height - margin,
      "bottom-center": margin
    };

    onChange(
      normalizedPlacement({
        ...base,
        x: xByPosition[position],
        y: yByPosition[position]
      })
    );
  }

  function setStampSize(width: number, height: number) {
    onChange(normalizedPlacement({ ...placement, width, height }));
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPlacement: placement
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current || !pageInfo) return;

    const dx = (event.clientX - dragRef.current.startClientX) / pageInfo.scale;
    const dy = (event.clientY - dragRef.current.startClientY) / pageInfo.scale;
    onChange(
      normalizedPlacement({
        ...dragRef.current.startPlacement,
        x: dragRef.current.startPlacement.x + dx,
        y: dragRef.current.startPlacement.y - dy
      })
    );
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
  }

  const overlayStyle =
    pageInfo &&
    ({
      left: placement.x * pageInfo.scale,
      top: (pageInfo.height - placement.y - placement.height) * pageInfo.scale,
      width: placement.width * pageInfo.scale,
      height: placement.height * pageInfo.scale
    } as const);

  return (
    <div className="stamp-placement" inert={disabled}>
      <div className="section-title">
        <div>
          <h3>Stamp layout</h3>
          <p>Drag the approval stamp to an empty area of the invoice.</p>
        </div>
        {pdfDoc ? (
          <label className="page-selector">
            Page
            <select
              aria-label="Invoice page"
              value={placement.pageIndex}
              onChange={(event) => onChange({ ...placement, pageIndex: Number(event.target.value) })}
            >
              {Array.from({ length: pdfDoc.numPages }, (_, index) => (
                <option key={index} value={index}>{index + 1} of {pdfDoc.numPages}</option>
              ))}
            </select>
          </label>
        ) : <span>{loadError ? "Preview unavailable" : "Loading preview"}</span>}
      </div>

      <div className="stamp-preview-frame" ref={frameRef}>
        {loadError ? (
          <div className="preview-error">{loadError}</div>
        ) : (
          <div className="stamp-preview-page">
            <canvas ref={canvasRef} />
            {pageInfo && overlayStyle && (
              <div
                className="stamp-overlay"
                style={overlayStyle}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={() => { dragRef.current = null; }}
              >
                <span>Approval stamp</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="placement-controls">
        <button type="button" onClick={() => applyPreset("bottom-left")}>Bottom left</button>
        <button type="button" onClick={() => applyPreset("bottom-right")}>Bottom right</button>
        <button type="button" onClick={() => applyPreset("bottom-center")}>Bottom center</button>
        <button type="button" onClick={() => applyPreset("top-left")}>Top left</button>
        <button type="button" onClick={() => applyPreset("top-right")}>Top right</button>
      </div>

      <div className="placement-controls compact-controls">
        <button type="button" onClick={() => setStampSize(260, 92)}>Tiny</button>
        <button type="button" onClick={() => setStampSize(320, 110)}>Small</button>
        <button type="button" onClick={() => setStampSize(380, 128)}>Standard</button>
        <button type="button" onClick={() => setStampSize(440, 148)}>Large</button>
      </div>

      <details className="stamp-advanced">
        <summary>Advanced coordinates</summary>
        <div className="stamp-grid">
          {(["pageIndex", "x", "y", "width", "height"] as const).map((field) => (
            <label key={field}>
              {field === "pageIndex" ? "Page" : field.toUpperCase()}
              <input
                type="number"
                value={field === "pageIndex" ? placement[field] + 1 : Math.round(placement[field])}
                onChange={(event) => {
                  const rawValue = Number(event.target.value);
                  onChange(
                    normalizedPlacement({
                      ...placement,
                      [field]: field === "pageIndex" ? Math.max(0, rawValue - 1) : rawValue
                    })
                  );
                }}
              />
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}

export default App;

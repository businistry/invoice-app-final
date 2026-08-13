import {
  Activity,
  Archive,
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
  PanelLeftClose,
  PanelLeftOpen,
  ReceiptText,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Table2,
  Trash2,
  UploadCloud,
  Wand2,
  X
} from "lucide-react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
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
import type { GlCode, GlImportReport, InvoiceGlLine, InvoiceRecord, StampSettings } from "./types";

type View = "queue" | "library" | "gl" | "settings";
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
  const label = status.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
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
    stampLines.length > 0 &&
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

function isPendingInvoice(invoice: InvoiceRecord): boolean {
  return invoice.status === "needs_review" || invoice.status === "error";
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
  const [invoiceFilter, setInvoiceFilter] = useState<InvoiceFilter>("all");
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
  const [queueOpen, setQueueOpen] = useState(true);

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
    if (!selectedId && invoiceData.invoices[0]) setSelectedId(invoiceData.invoices[0].id);
  }

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
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
      await refresh();
      setSelectedId(uploaded.invoices[0]?.id || selectedId);
      setQueueOpen(false);
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
      const driveMessage = finalized.driveUploadError
        ? ` Drive upload needs attention: ${finalized.driveUploadError}`
        : finalized.driveUploadedAt
          ? " Sent to Google Drive."
          : "";
      setMessage(finalized.finalFileName ? `Finalized ${finalized.finalFileName}.${driveMessage}` : "Invoice needs review.");
      setView(finalized.finalFileName ? "library" : "queue");
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
      setMessage("");
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

  async function handleSendToDrive(invoice: InvoiceRecord) {
    setBusy(true);
    setMessage("Sending PDF to Google Drive...");
    try {
      const updated = await sendInvoiceToDrive(invoice.id);
      setInvoices((current) => current.map((record) => (record.id === updated.id ? updated : record)));
      if (selectedId === updated.id) setDraft(cloneInvoice(updated));
      setMessage(
        updated.driveUploadError
          ? `Drive upload needs attention: ${updated.driveUploadError}`
          : `Sent ${updated.driveFileName || updated.finalFileName || "PDF"} to Google Drive.`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Google Drive upload failed");
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

  function showInvoiceFilter(filter: InvoiceFilter, nextView: View = "queue") {
    const nextInvoices = invoicesForFilter(invoices, filter);
    const nextId = nextInvoices[0]?.id || "";
    if (
      nextId !== selectedId &&
      draftIsDirty &&
      !window.confirm("Discard your unsaved changes and switch views?")
    ) {
      return;
    }
    setInvoiceFilter(filter);
    setView(nextView);
    setSelectedId(nextId);
  }

  function selectInvoice(id: string) {
    if (id === selectedId) return;
    if (draftIsDirty && !window.confirm("Discard your unsaved changes and open another invoice?")) return;
    setSelectedId(id);
  }

  const activeViewTitle =
    view === "queue" ? "Invoice Command" : view === "library" ? "Finalized Vault" : view === "gl" ? "GL Intelligence" : "Control Surface";
  const activeViewSubtitle =
    view === "queue"
      ? "Review, code, stamp, and finalize invoices from one focused cockpit."
      : view === "library"
        ? "Search-ready finalized PDFs with clean naming and audit context."
        : view === "gl"
          ? "The matching brain: codes, descriptions, and keyword signals."
          : "Tune approval initials and automation thresholds.";
  const topSuggestion = draft?.glSuggestions[0];
  const draftLineTotal = draft ? sumLines(draft.glLines) : 0;
  const amountBalance =
    draft && typeof draft.extraction.totalAmount === "number"
      ? Number((draft.extraction.totalAmount - draftLineTotal).toFixed(2))
      : null;
  const finalizeBlockers = draft ? validationWarningsForDraft(draft) : [];
  const persistedDraft = draft ? invoices.find((invoice) => invoice.id === draft.id) : null;
  const draftIsDirty =
    Boolean(draft && persistedDraft) &&
    JSON.stringify({
      extraction: draft?.extraction,
      glLines: draft?.glLines,
      stampPlacement: draft?.stampPlacement
    }) !==
      JSON.stringify({
        extraction: persistedDraft?.extraction,
        glLines: persistedDraft?.glLines,
        stampPlacement: persistedDraft?.stampPlacement
      });
  const sourceWarnings = draft ? [...draft.extraction.warnings, ...(draft.error ? [draft.error] : [])] : [];
  const firstActiveLineIndex = draft ? draft.glLines.findIndex((line) => line.glCode.trim() || typeof line.amount === "number") : -1;
  const canSetSingleLineTotal =
    Boolean(draft) &&
    typeof draft?.extraction.totalAmount === "number" &&
    activeGlLines(draft.glLines).length === 1 &&
    firstActiveLineIndex >= 0 &&
    amountBalance !== 0;

  useEffect(() => {
    function protectUnsavedChanges(event: BeforeUnloadEvent) {
      if (!draftIsDirty) return;
      event.preventDefault();
    }

    window.addEventListener("beforeunload", protectUnsavedChanges);
    return () => window.removeEventListener("beforeunload", protectUnsavedChanges);
  }, [draftIsDirty]);

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
          <button className={view === "queue" ? "active" : ""} onClick={() => showInvoiceFilter("all")}>
            <ReceiptText size={18} /> Command
          </button>
          <button className={view === "library" ? "active" : ""} onClick={() => setView("library")}>
            <Archive size={18} /> Vault
          </button>
          <button className={view === "gl" ? "active" : ""} onClick={() => setView("gl")}>
            <Table2 size={18} /> GL Brain
          </button>
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
            <Settings size={18} /> Controls
          </button>
        </nav>
        <div className="rail-status">
          <span>STLMO</span>
          <button type="button" onClick={() => showInvoiceFilter("pending")}>
            <strong>{queueInvoices.length} pending</strong>
          </button>
          <button type="button" onClick={() => showInvoiceFilter("finalized", "library")}>
            <em>{finalizedInvoices.length} finalized documents</em>
          </button>
        </div>
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
              className={`metric-card ${view === "library" ? "active" : ""}`}
              onClick={() => showInvoiceFilter("finalized", "library")}
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

        {message && (
          <div className="notice app-notice" role="status" aria-live="polite">
            <span>{message}</span>
            <button type="button" onClick={() => setMessage("")} aria-label="Dismiss message">
              <X size={16} />
            </button>
          </div>
        )}

        {view === "queue" && (
          <section className={`queue-layout console-grid ${queueOpen ? "" : "queue-collapsed"}`}>
            <div className={`left-column intelligence-queue ${queueOpen ? "" : "collapsed"}`}>
              {queueOpen ? (
                <>
                  <div className="panel-title">
                <div>
                  <span>Intake</span>
                  <h2>Invoice Queue</h2>
                </div>
                <div className="panel-title-actions">
                  <em>{displayedInvoiceCountLabel}</em>
                  {draft && (
                    <button
                      type="button"
                      className="icon-action"
                      onClick={() => setQueueOpen(false)}
                      aria-label="Collapse invoice queue"
                      title="Collapse invoice queue"
                    >
                      <PanelLeftClose size={16} />
                    </button>
                  )}
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
                    <span>Choose or drop invoice PDFs</span>
                    <small>PDF · multiple files supported</small>
                    <input type="file" accept="application/pdf" multiple onChange={handleUpload} />
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
                  Review
                </button>
                <button
                  type="button"
                  className={invoiceFilter === "finalized" ? "active-filter" : ""}
                  onClick={() => showInvoiceFilter("finalized")}
                  aria-pressed={invoiceFilter === "finalized"}
                >
                  Final
                </button>
              </div>

              <div className="invoice-list">
                {displayedInvoices.map((invoice) => (
                  <button
                    key={invoice.id}
                    className={`invoice-row ${selectedId === invoice.id ? "selected" : ""}`}
                    onClick={() => selectInvoice(invoice.id)}
                  >
                    <span className="doc-chip"><FileText size={15} /></span>
                    <div>
                      <strong>{invoice.extraction.vendorName || invoice.originalName}</strong>
                      <span>{invoice.extraction.invoiceNumber || "No invoice number"} · {formatMoney(invoice.extraction.totalAmount)}</span>
                    </div>
                    <em className={`status ${invoice.status}`}>{statusLabel(invoice.status)}</em>
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
                </>
              ) : (
                <button
                  type="button"
                  className="queue-reveal"
                  onClick={() => setQueueOpen(true)}
                  aria-label={`Open invoice queue, ${displayedInvoices.length} invoices`}
                  title="Open invoice queue"
                >
                  <PanelLeftOpen size={20} />
                  <span>Queue</span>
                  <strong>{displayedInvoices.length}</strong>
                </button>
              )}
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
                      <div className="confidence-pill">
                        <Sparkles size={15} />
                        {formatPercent(draft.extraction.confidence)} extraction
                      </div>
                    </div>
                    <InvoiceDocumentPreview invoiceId={draft.id} />
                    <div className="document-footer">
                      <span><Bot size={14} /> {topSuggestion ? `${topSuggestion.glCode} suggested` : "Awaiting GL signal"}</span>
                      <span>
                        <ShieldCheck size={14} />
                        {finalizeBlockers.length === 0
                          ? "Ready to finalize"
                          : `${finalizeBlockers.length} item${finalizeBlockers.length === 1 ? "" : "s"} to finish`}
                      </span>
                    </div>
                  </div>
                  <aside className="review-panel approval-cockpit">
                    <div className="panel-heading">
                      <div>
                        <span>Approval Cockpit</span>
                        <h2>{draft.extraction.vendorName || "Unidentified vendor"}</h2>
                        <em className={`draft-state ${draftIsDirty ? "is-dirty" : ""}`}>
                          {draftIsDirty ? "Unsaved changes" : "All changes saved"}
                        </em>
                      </div>
                      <BadgeCheck size={22} />
                    </div>

                    {sourceWarnings.length > 0 && (
                      <div className="warning-list">
                        {sourceWarnings.map((warning) => (
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
                        <input type="date" value={draft.extraction.invoiceDate} onChange={(event) => updateExtraction("invoiceDate", event.target.value)} />
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

                    <PdfStampPlacementEditor
                      invoiceId={draft.id}
                      placement={draft.stampPlacement}
                      onChange={(stampPlacement) => updateDraft({ stampPlacement })}
                    />

                    <div className="actions">
                      <button className="danger-action subtle-danger" onClick={() => handleDeleteInvoice(draft)} disabled={busy}>
                        <Trash2 size={18} /> Delete PDF
                      </button>
                      <button onClick={saveDraft} disabled={busy || !draftIsDirty}>Save changes</button>
                      <button
                        className="primary"
                        onClick={handleFinalize}
                        disabled={busy || finalizeBlockers.length > 0}
                        title={finalizeBlockers.length > 0 ? finalizeBlockers.join(" ") : undefined}
                      >
                        <CheckCircle2 size={18} /> Approve &amp; finalize
                      </button>
                    </div>

                    {draft.finalFileName && (
                      <div className="final-file-actions">
                        <a className="download-link" href={`/api/invoices/${draft.id}/final.pdf`}>
                          <Download size={18} /> {draft.finalFileName}
                        </a>
                        <button className="download-link" onClick={() => handleSendToDrive(draft)} disabled={busy}>
                          <CloudUpload size={18} /> {draft.driveUploadedAt ? "Send again to Drive" : "Send to Drive"}
                        </button>
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
                  <div className="empty-state-icon"><ReceiptText size={26} /></div>
                  <h2>Ready for your first invoice</h2>
                  <p>Upload one or more PDFs, confirm the extracted details, assign GL codes, and finalize the stamped file.</p>
                  <div className="empty-steps" aria-label="Invoice workflow">
                    <span><strong>1</strong> Upload</span>
                    <span><strong>2</strong> Review &amp; code</span>
                    <span><strong>3</strong> Finalize</span>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {view === "library" && (
          <section className="library-list vault-list">
            {finalizedInvoices.map((invoice) => (
              <article key={invoice.id} className="library-row">
                <div>
                  <strong>{invoice.finalFileName}</strong>
                  <span>{invoice.extraction.vendorName} · {formatMoney(invoice.extraction.totalAmount)} · {invoice.finalizedAt?.slice(0, 10)}</span>
                  {invoice.driveUploadedAt && <span className="drive-status">Sent to Google Drive {invoice.driveUploadedAt.slice(0, 10)}</span>}
                  {invoice.driveUploadError && <span className="drive-error inline-error">{invoice.driveUploadError}</span>}
                </div>
                <div className="library-actions">
                  <a href={`/api/invoices/${invoice.id}/final.pdf`}>
                    <Download size={18} /> Download
                  </a>
                  {invoice.driveWebViewLink ? (
                    <a href={invoice.driveWebViewLink} target="_blank" rel="noreferrer">
                      <ExternalLink size={18} /> Drive
                    </a>
                  ) : (
                    <button onClick={() => handleSendToDrive(invoice)} disabled={busy}>
                      <CloudUpload size={18} /> Drive
                    </button>
                  )}
                  <button className="danger-action" onClick={() => handleDeleteInvoice(invoice)} disabled={busy}>
                    <Trash2 size={18} /> Delete
                  </button>
                </div>
              </article>
            ))}
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

function InvoiceDocumentPreview({ invoiceId }: { invoiceId: string }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [frameWidth, setFrameWidth] = useState(0);
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

    async function renderFirstPage() {
      const canvas = canvasRef.current;
      if (!canvas || !pdfDoc) return;

      const page = await pdfDoc.getPage(1);
      if (cancelled) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const targetWidth = clamp(frameWidth - 32, 260, 620);
      const scale = clamp(targetWidth / baseViewport.width, 0.38, 0.92);
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
      await renderTask.promise.catch(() => undefined);
    }

    void renderFirstPage();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDoc, frameWidth]);

  return (
    <div className="source-preview-frame" ref={frameRef}>
      {loadError ? <div className="preview-error">{loadError}</div> : <canvas ref={canvasRef} />}
    </div>
  );
}

function PdfStampPlacementEditor({
  invoiceId,
  placement,
  onChange
}: {
  invoiceId: string;
  placement: InvoiceRecord["stampPlacement"];
  onChange: (placement: InvoiceRecord["stampPlacement"]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{
    startClientX: number;
    startClientY: number;
    startPlacement: InvoiceRecord["stampPlacement"];
  } | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageInfo, setPageInfo] = useState<PageRenderInfo | null>(null);
  const [loadError, setLoadError] = useState("");

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
    if (!pdfDoc || !canvasRef.current) return;

    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;

    async function renderPage() {
      const canvas = canvasRef.current;
      if (!canvas || !pdfDoc) return;

      const pageNumber = clamp(placement.pageIndex + 1, 1, pdfDoc.numPages);
      const page = await pdfDoc.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(340 / baseViewport.width, 0.72);
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
      await renderTask.promise.catch(() => undefined);

      if (!cancelled) {
        setPageInfo({ width: baseViewport.width, height: baseViewport.height, scale });
      }
    }

    void renderPage();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDoc, placement.pageIndex]);

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
    <div className="stamp-placement">
      <div className="section-title">
        <h3>Stamp Placement</h3>
        <span>{pageInfo ? `Page ${placement.pageIndex + 1} of ${pdfDoc?.numPages || 1}` : "Loading preview"}</span>
      </div>

      <div className="stamp-preview-frame">
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

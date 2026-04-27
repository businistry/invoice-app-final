import {
  Activity,
  Archive,
  BadgeCheck,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  Clock3,
  Command,
  Download,
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
  UploadCloud,
  Wand2
} from "lucide-react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
import { ChangeEvent, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ApiError,
  fetchConfig,
  fetchGlCodes,
  fetchInvoices,
  finalizeInvoice,
  importGlCodes,
  saveStampSettings,
  updateInvoice,
  uploadInvoices
} from "./api";
import type { GlCode, GlImportReport, InvoiceGlLine, InvoiceRecord, StampSettings } from "./types";

type View = "queue" | "library" | "gl" | "settings";
type PageRenderInfo = { width: number; height: number; scale: number };

GlobalWorkerOptions.workerSrc = pdfWorker;

const emptySettings: StampSettings = { gmInitials: "TC", autoConfidenceThreshold: 0.72 };

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

function App() {
  const [view, setView] = useState<View>("queue");
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [glCodes, setGlCodes] = useState<GlCode[]>([]);
  const [reports, setReports] = useState<GlImportReport[]>([]);
  const [settings, setSettings] = useState<StampSettings>(emptySettings);
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");
  const [draft, setDraft] = useState<InvoiceRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [glSearch, setGlSearch] = useState("");

  async function refresh() {
    const [config, invoiceData, glData] = await Promise.all([fetchConfig(), fetchInvoices(), fetchGlCodes()]);
    setSettings(config.settings);
    setHasOpenAiKey(config.hasOpenAiKey);
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

  const queueInvoices = invoices.filter((invoice) => invoice.status === "needs_review" || invoice.status === "error");
  const finalizedInvoices = invoices.filter((invoice) => invoice.finalFileName);
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
      setMessage(finalized.finalFileName ? `Finalized ${finalized.finalFileName}` : "Invoice needs review.");
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
          <button className={view === "queue" ? "active" : ""} onClick={() => setView("queue")}>
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
          <strong>{queueInvoices.length} pending</strong>
          <em>{finalizedInvoices.length} finalized documents</em>
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
            <div>
              <Clock3 size={16} />
              <span>{queueInvoices.length}</span>
              <small>pending</small>
            </div>
            <div>
              <FileStack size={16} />
              <span>{finalizedInvoices.length}</span>
              <small>finalized</small>
            </div>
            <div>
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
                  <span>Intake</span>
                  <h2>Invoice Queue</h2>
                </div>
                <em>{invoices.length} total</em>
              </div>
              <label className="upload-zone elevated-upload">
                <UploadCloud size={24} />
                <span>Drop invoice PDFs</span>
                <input type="file" accept="application/pdf" multiple onChange={handleUpload} />
              </label>

              <div className="queue-filters">
                <span className="active-filter">All</span>
                <span>Review</span>
                <span>Final</span>
              </div>

              <div className="invoice-list">
                {invoices.map((invoice) => (
                  <button
                    key={invoice.id}
                    className={`invoice-row ${selectedId === invoice.id ? "selected" : ""}`}
                    onClick={() => setSelectedId(invoice.id)}
                  >
                    <span className="doc-chip"><FileText size={15} /></span>
                    <div>
                      <strong>{invoice.extraction.vendorName || invoice.originalName}</strong>
                      <span>{invoice.extraction.invoiceNumber || "No invoice number"} · {formatMoney(invoice.extraction.totalAmount)}</span>
                    </div>
                    <em className={`status ${invoice.status}`}>{statusLabel(invoice.status)}</em>
                  </button>
                ))}
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
                      <div className="confidence-pill">
                        <Sparkles size={15} />
                        {formatPercent(draft.extraction.confidence)} extraction
                      </div>
                    </div>
                    <InvoiceDocumentPreview invoiceId={draft.id} />
                    <div className="document-footer">
                      <span><Bot size={14} /> {topSuggestion ? `${topSuggestion.glCode} suggested` : "Awaiting GL signal"}</span>
                      <span><ShieldCheck size={14} /> {draft.warnings.length === 0 ? "Ready to finalize" : `${draft.warnings.length} review note${draft.warnings.length === 1 ? "" : "s"}`}</span>
                    </div>
                  </div>
                  <aside className="review-panel approval-cockpit">
                    <div className="panel-heading">
                      <div>
                        <span>Approval Cockpit</span>
                        <h2>{draft.extraction.vendorName || "Unidentified vendor"}</h2>
                      </div>
                      <BadgeCheck size={22} />
                    </div>

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

                    <PdfStampPlacementEditor
                      invoiceId={draft.id}
                      placement={draft.stampPlacement}
                      onChange={(stampPlacement) => updateDraft({ stampPlacement })}
                    />

                    <div className="actions">
                      <button onClick={saveDraft} disabled={busy}>Save</button>
                      <button
                        className="primary"
                        onClick={handleFinalize}
                        disabled={busy || finalizeBlockers.length > 0}
                        title={finalizeBlockers.length > 0 ? finalizeBlockers.join(" ") : undefined}
                      >
                        <CheckCircle2 size={18} /> Finalize PDF
                      </button>
                    </div>

                    {draft.finalFileName && (
                      <a className="download-link" href={`/api/invoices/${draft.id}/final.pdf`}>
                        <Download size={18} /> {draft.finalFileName}
                      </a>
                    )}
                  </aside>
                </>
              ) : (
                <div className="empty-state">No invoice selected.</div>
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
                </div>
                <a href={`/api/invoices/${invoice.id}/final.pdf`}>
                  <Download size={18} /> Download
                </a>
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
    const width = clamp(next.width, 300, Math.max(300, pageInfo.width - 24));
    const height = clamp(next.height, 108, Math.max(108, pageInfo.height - 24));

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

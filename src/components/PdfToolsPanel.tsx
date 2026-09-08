import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, RefreshCw, Download, FolderOpen, Send, CheckCircle2, ChevronUp, ChevronDown } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { projectApi } from '../utils/projectApi';
import { usePanelPolling, useFlashMessage } from '../hooks/usePanelPolling';
import { cn } from '../lib/utils';
import { EmptyState } from './ui/EmptyState';
import type { Project } from '../types';
import { MergeCard, PdfFileList } from './pdfTools/mergeCard';
import { formatSize, sanitizeOutputName } from './pdfTools/utils';
import type { PdfFileInfo } from './pdfTools/utils';

// Phase 3 (UPGRADE-ROADMAP.md, 2026-08-11): the PDF Tools panel — the interactive half of the
// PDF toolkit. The panel never executes anything itself: every operation composes the exact
// trigger-command line the chat already understands ("merge a.pdf and b.pdf into c.pdf"), so
// the message goes through the normal pipeline — matcher -> pdf.* intent -> standard confirm
// flow -> pdfKit.js execution -> actionHistory journaling. The terminal stays the single
// source of truth for confirm cards, answers and errors (same contract as Dashboard's Run/Stop
// buttons); this panel is the file-picking convenience layer around it.
// 2026-08-24 split: the merge card + file list + helpers live in pdfTools/*.

interface PdfToolsPanelProps {
  project: Project | null;
  onSendMessage: (text: string) => void;
  /** Phase T (2026-08-14): the tab whose workspace this panel's REST calls address. */
  tabId?: string | null;
}

const POLL_MS = 6000;

export function PdfToolsPanel({ project, onSendMessage, tabId = null }: PdfToolsPanelProps) {
  const [files, setFiles] = useState<PdfFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSent, flashSent] = useFlashMessage();

  // Single-file picker used by split / extract-text / extract-pages / watermark.
  const [selected, setSelected] = useState<string>('');
  // Merge picks its own multi-selection, ORDERED (2026-08-24): PDF merge output depends on
  // input order (a+b+c != a+c+b), so the selection is an ordered array — chips append on
  // click, and the order row below reorders before sending.
  const [mergeOrder, setMergeOrder] = useState<string[]>([]);
  const [mergeOutput, setMergeOutput] = useState('combined.pdf');
  const [splitMode, setSplitMode] = useState<'perPage' | 'at'>('perPage');
  const [splitAt, setSplitAt] = useState('5');
  const [pageFrom, setPageFrom] = useState('1');
  const [pageTo, setPageTo] = useState('2');
  const [extractOutput, setExtractOutput] = useState('');
  const [watermarkText, setWatermarkText] = useState('confidential');
  // Stage D: extract-text and extract-pages share one 2x2 grid cell (text | pages sub-mode).
  const [extractMode, setExtractMode] = useState<'text' | 'pages'>('text');

  // Stage D: drag-and-drop upload zone with a file-picker fallback. The file is POSTed to
  // /api/projects/:id/pdf-upload (project-scoped, journaled) and the list refreshes so the
  // existing operation pickers work on it immediately.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  const uploadFile = async (file: File) => {
    if (!project?.id) return;
    if (!/\.pdf$/i.test(file.name)) { setError('Only .pdf files can be dropped here.'); return; }
    setUploading(true);
    setError(null);
    try {
      const res = await fetch(
        projectApi(`/api/projects/${encodeURIComponent(project.id)}/pdf-upload?file=${encodeURIComponent(file.name)}`, tabId),
        { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file }
      );
      const data = await res.json();
      if (!res.ok) { setError(data?.error || 'Upload failed.'); return; }
      await fetchFiles();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setUploading(false);
    }
  };

  const fetchFiles = useCallback(async () => {
    if (!project?.id) return;
    setLoading(true);
    const data = await apiFetchJson<{ files: PdfFileInfo[] }>(projectApi(`/api/projects/${encodeURIComponent(project.id)}/pdf-files`, tabId));
    setLoading(false);
    if (!data) {
      setError('Could not load the PDF list — check that the server is up.');
      return;
    }
    setError(null);
    setFiles(data.files || []);
  }, [project?.id, tabId]);

  useEffect(() => {
    setFiles([]);
    setSelected('');
    setMergeOrder([]);
  }, [project?.id]);

  usePanelPolling(fetchFiles, POLL_MS, !!project?.id);

  // Selection must never point at a file that vanished from the list (a deleted/renamed PDF
  // would compose a command against a name the server can't resolve — harmless, but stale UI).
  useEffect(() => {
    const names = new Set(files.map((f) => f.name));
    if (selected && !names.has(selected)) setSelected('');
    setMergeOrder((prev) => prev.filter((n) => names.has(n)));
  }, [files, selected]);

  // D-7 (2026-09-08): merge/split/extract-pages/watermark now hit direct REST endpoints
  // (pdfRoutes.js) instead of composing a chat trigger phrase. The panel already has
  // structured params from its own pickers (file dropdowns, page-range inputs) -- no
  // chat-phrase composing/parsing needed on either side -- and the Run button was already
  // the confirm step, so the WS round-trip was pure overhead (same reasoning as the notes/
  // spreadsheet/file-tools slices). The REST endpoints replicate the exact checkpoint +
  // pdfKit.js-call + journal sequence from connectionConfirm.js's pdfOp branch, so
  // 'revert action <id>' and the undo toast keep working identically. extract_text stays
  // read-only (no checkpoint) and now renders its preview inline instead of in a chat bubble.

  const [extractedText, setExtractedText] = useState<{ file: string; preview: string; pages: number } | null>(null);

  const fileUrl = (path: string) =>
    projectApi(`/api/projects/${encodeURIComponent(project?.id || '')}/file?path=${encodeURIComponent(path)}`, tabId);

  const reveal = async (path: string) => {
    try {
      await fetch(projectApi(`/api/projects/${encodeURIComponent(project?.id || '')}/reveal`, tabId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
    } catch {
      // Best-effort convenience — a failed reveal never blocks the panel.
    }
  };

  const mergeList = mergeOrder;
  const mergeDisabled = mergeList.length < 2 || !sanitizeOutputName(mergeOutput);

  const toggleMerge = (name: string) => {
    setMergeOrder((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  };

  const moveMerge = (idx: number, dir: -1 | 1) => {
    setMergeOrder((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const sendMerge = async () => {
    if (mergeDisabled || !project?.id) return;
    const out = sanitizeOutputName(mergeOutput);
    setLoading(true);
    const result = await apiFetchJson<{ ok: boolean; output?: string; pages?: number; bytes?: number; error?: string }>(
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/pdf/merge`, tabId),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs: mergeList, output: out }) }
    );
    setLoading(false);
    if (!result) { setError('Could not reach the server.'); return; }
    if (!result.ok) { setError(result.error || 'Merge failed.'); return; }
    setError(null);
    flashSent(`Merged ${mergeList.length} PDF(s) into ${result.output} (${result.pages} page(s)). Undo with "revert action <id>".`);
    fetchFiles();
  };

  const sendSplit = async () => {
    if (!selected || !project?.id) return;
    setLoading(true);
    const result = await apiFetchJson<{ ok: boolean; outputs?: { path: string; pages: number }[]; error?: string }>(
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/pdf/split`, tabId),
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: selected, mode: splitMode, at: splitMode === 'at' ? Number(splitAt.trim() || '1') : undefined }),
      }
    );
    setLoading(false);
    if (!result) { setError('Could not reach the server.'); return; }
    if (!result.ok) { setError(result.error || 'Split failed.'); return; }
    setError(null);
    flashSent(`Split into ${result.outputs?.length ?? 0} file(s). Undo with "revert action <id>".`);
    fetchFiles();
  };

  const sendExtractText = async () => {
    if (!selected || !project?.id) return;
    setLoading(true);
    const result = await apiFetchJson<{ ok: boolean; text?: string; preview?: string; pages?: number; error?: string }>(
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/pdf/extract-text?input=${encodeURIComponent(selected)}`, tabId)
    );
    setLoading(false);
    if (!result) { setError('Could not reach the server.'); return; }
    if (!result.ok) { setError(result.error || 'Text extraction failed.'); setExtractedText(null); return; }
    setError(null);
    setExtractedText({ file: selected, preview: result.preview || '(no extractable text)', pages: result.pages ?? 0 });
  };

  const sendExtractPages = async () => {
    if (!selected || !project?.id) return;
    const out = sanitizeOutputName(extractOutput) || undefined;
    setLoading(true);
    const result = await apiFetchJson<{ ok: boolean; output?: string; pages?: number; error?: string }>(
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/pdf/extract-pages`, tabId),
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: selected, from: Number(pageFrom.trim() || '1'), to: Number(pageTo.trim() || '2'), output: out }),
      }
    );
    setLoading(false);
    if (!result) { setError('Could not reach the server.'); return; }
    if (!result.ok) { setError(result.error || 'Extraction failed.'); return; }
    setError(null);
    flashSent(`Extracted ${result.pages} page(s) into ${result.output}. Undo with "revert action <id>".`);
    fetchFiles();
  };

  const sendWatermark = async () => {
    if (!selected || !watermarkText.trim() || !project?.id) return;
    setLoading(true);
    const result = await apiFetchJson<{ ok: boolean; output?: string; pages?: number; error?: string }>(
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/pdf/watermark`, tabId),
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: selected, text: watermarkText.trim() }),
      }
    );
    setLoading(false);
    if (!result) { setError('Could not reach the server.'); return; }
    if (!result.ok) { setError(result.error || 'Watermark failed.'); return; }
    setError(null);
    flashSent(`Watermarked into ${result.output}. Undo with "revert action <id>".`);
    fetchFiles();
  };

  const FilePicker = (
    <select
      value={selected}
      onChange={(e) => { setSelected(e.target.value); setExtractedText(null); }}
      className="w-full text-xs bg-panel-strong border border-border-soft rounded-lg px-2.5 py-2 text-fg-strong focus:outline-none focus:border-accent/50"
    >
      <option value="">Pick a PDF…</option>
      {files.map((f) => (
        <option key={f.path} value={f.name}>{f.name} ({formatSize(f.size)})</option>
      ))}
    </select>
  );

  const card = 'bg-panel rounded-xl border border-border-soft p-4';
  const label = 'block text-[11px] uppercase tracking-wider text-fg-dim mb-1.5';
  const inputCls = 'w-full text-xs bg-panel-strong border border-border-soft rounded-lg px-2.5 py-2 text-fg-strong focus:outline-none focus:border-accent-blue/50';
  const runBtn = 'mt-3 w-full min-h-11 flex items-center justify-center gap-1.5 text-xs font-bold rounded-lg px-3 py-2 bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed';
  const smallBtn = 'p-1.5 text-fg-dim hover:text-fg-strong transition-colors rounded-lg hover:bg-scrim-faint';

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-scrim-faint rounded-lg text-accent">
              <FileText size={16} />
            </div>
            <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase">PDF Tools</h2>
            {project && (
              <span className="text-xs text-fg-dim font-normal normal-case">— {project.name}</span>
            )}
          </div>
          <button onClick={fetchFiles} className={cn(smallBtn, loading && 'opacity-50')} title="Refresh the file list">
            <RefreshCw size={15} className={cn(loading && 'animate-spin')} />
          </button>
        </div>

        {!project ? (
          <div className={cn(card, 'text-sm text-fg-muted')}>
            Select a project to work with its PDFs.
          </div>
        ) : (
          <>
            {/* Drag-and-drop upload zone — dashed --border-strong, file-picker fallback */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) uploadFile(f);
              }}
              className={`border-2 border-dashed rounded-xl p-5 mb-4 text-center transition-colors cursor-pointer ${dragging ? 'border-accent-blue bg-accent-blue/5' : 'border-border-strong bg-background hover:border-accent-blue/50'}`}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadFile(f);
                  e.target.value = '';
                }}
              />
              <p className="text-[13px] text-fg-muted">
                {uploading ? 'Uploading…' : dragging ? 'Drop it to upload' : 'Drag & drop a PDF into this project'}
              </p>
              <button
                onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                className="mt-1.5 text-[11px] text-accent-blue hover:underline"
              >
                or pick a file…
              </button>
            </div>

            <div className="grid gap-4 lg:grid-cols-5">
              <PdfFileList
                files={files}
                loading={loading}
                error={error}
                lastSent={lastSent}
                card={card}
                smallBtn={smallBtn}
                fileUrl={fileUrl}
                onReveal={reveal}
              />

            {/* Operations — 2x2 card grid */}
            <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <MergeCard
                files={files}
                mergeOrder={mergeOrder}
                mergeOutput={mergeOutput}
                card={card}
                inputCls={inputCls}
                runBtn={runBtn}
                onToggle={toggleMerge}
                onMove={moveMerge}
                onOutputChange={setMergeOutput}
                onMerge={sendMerge}
                mergeDisabled={mergeDisabled}
              />

              {/* Split */}
              <div className={card}>
                <h3 className="text-xs font-semibold text-fg-strong mb-3">Split a PDF</h3>
                {FilePicker}
                <div className="flex items-center gap-4 mt-2.5">
                  <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer">
                    <input
                      type="radio"
                      checked={splitMode === 'perPage'}
                      onChange={() => setSplitMode('perPage')}
                      className="accent-accent-blue"
                    />
                    One file per page
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer">
                    <input
                      type="radio"
                      checked={splitMode === 'at'}
                      onChange={() => setSplitMode('at')}
                      className="accent-accent-blue"
                    />
                    Two parts around page
                  </label>
                  {splitMode === 'at' && (
                    <input
                      value={splitAt}
                      onChange={(e) => setSplitAt(e.target.value.replace(/[^\d]/g, ''))}
                      className={cn(inputCls, '!w-16')}
                      placeholder="5"
                    />
                  )}
                </div>
                <button onClick={sendSplit} disabled={!selected} className={runBtn}>
                  <Send size={12} /> Split
                </button>
              </div>

              {/* Extract — text | pages sub-mode in one card */}
              <div className={card}>
                <h3 className="text-xs font-semibold text-fg-strong mb-3">Extract from a PDF</h3>
                {FilePicker}
                <div className="flex gap-1 mt-2.5 rounded-lg p-1 bg-scrim-faint border border-border-soft">
                  {(['text', 'pages'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setExtractMode(m)}
                      className={cn(
                        'flex-1 py-1 rounded-lg text-[11px] font-semibold transition-colors',
                        extractMode === m ? 'bg-accent-blue text-white' : 'text-fg-muted hover:text-fg-strong',
                      )}
                    >
                      {m === 'text' ? 'Text' : 'Pages'}
                    </button>
                  ))}
                </div>
                {extractMode === 'pages' && (
                  <div className="flex items-center gap-2 mt-2.5">
                    <span className="text-xs text-fg-dim">Pages</span>
                    <input
                      value={pageFrom}
                      onChange={(e) => setPageFrom(e.target.value.replace(/[^\d]/g, ''))}
                      className={cn(inputCls, '!w-14')}
                    />
                    <span className="text-xs text-fg-dim">to</span>
                    <input
                      value={pageTo}
                      onChange={(e) => setPageTo(e.target.value.replace(/[^\d]/g, ''))}
                      className={cn(inputCls, '!w-14')}
                    />
                    <input
                      value={extractOutput}
                      onChange={(e) => setExtractOutput(e.target.value)}
                      placeholder="output.pdf (optional)"
                      className={cn(inputCls, 'flex-1')}
                    />
                  </div>
                )}
                <button
                  onClick={extractMode === 'text' ? sendExtractText : sendExtractPages}
                  disabled={!selected}
                  className={runBtn}
                >
                  <Send size={12} /> {extractMode === 'text' ? 'Extract text' : 'Extract pages'}
                </button>
                {extractMode === 'text' && extractedText && (
                  <div className="mt-2.5 text-[11px] bg-scrim-faint border border-border-soft rounded-lg p-2.5">
                    <p className="text-fg-dim mb-1">
                      {extractedText.file} ({extractedText.pages} page{extractedText.pages === 1 ? '' : 's'})
                    </p>
                    <pre className="whitespace-pre-wrap break-words text-fg-strong max-h-40 overflow-y-auto font-mono">{extractedText.preview}</pre>
                  </div>
                )}
              </div>

              {/* Watermark */}
              <div className={card}>
                <h3 className="text-xs font-semibold text-fg-strong mb-3">Watermark</h3>
                {FilePicker}
                <div className="flex gap-2 mt-2.5">
                  <input
                    value={watermarkText}
                    onChange={(e) => setWatermarkText(e.target.value)}
                    placeholder="confidential"
                    className={cn(inputCls, 'flex-1')}
                  />
                </div>
                <button onClick={sendWatermark} disabled={!selected || !watermarkText.trim()} className={runBtn}>
                  <Send size={12} /> Watermark
                </button>
              </div>
            </div>
          </div>
        </>
      )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Table, RefreshCw, Send, CheckCircle2, ArrowUpDown } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { cn } from '../lib/utils';
import type { Project } from '../types';

// Phase 7 (UPGRADE-ROADMAP.md, 2026-08-12): the Spreadsheet panel — Apple Numbers/Sheets
// reference (toolbar row above a real table: sticky header, zebra striping, hover rows,
// sortable columns). Sum/Average/Count Run buttons compose the exact chat trigger command;
// Filter renders the result in-panel from the same read-only csvTools.js path the chat
// answer uses (GET /api/projects/:id/csv-filter), so the table and the terminal can never
// diverge. Every evaluation still goes through the server-side CSV engine — no client-side
// reimplementation.

interface CsvFile {
  path: string;
  name: string;
  size: number;
}

interface SpreadsheetPanelProps {
  project: Project | null;
  onSendMessage: (text: string) => void;
}

const POLL_MS = 15000;
const CSV_OPS = ['equals', 'contains', 'greater than', 'less than'];

type Mode = 'sum' | 'average' | 'count' | 'filter';

export function SpreadsheetPanel({ project, onSendMessage }: SpreadsheetPanelProps) {
  const [files, setFiles] = useState<CsvFile[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [column, setColumn] = useState('');
  const [mode, setMode] = useState<Mode>('sum');
  const [op, setOp] = useState('equals');
  const [filterValue, setFilterValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [table, setTable] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const lastSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchFiles = useCallback(async () => {
    if (!project?.id) return;
    setLoading(true);
    const data = await apiFetchJson<{ files: CsvFile[] }>(`/api/projects/${encodeURIComponent(project.id)}/csv-files`);
    setLoading(false);
    if (!data) { setError('Could not load CSV files.'); return; }
    setError(null);
    setFiles(data.files || []);
  }, [project?.id]);

  useEffect(() => {
    if (project?.id) {
      setSelectedFile('');
      setHeaders([]);
      setColumn('');
      setTable(null);
      fetchFiles();
      const t = setInterval(fetchFiles, POLL_MS);
      return () => clearInterval(t);
    }
  }, [project?.id, fetchFiles]);

  const fetchHeaders = useCallback(async (filePath: string) => {
    if (!project?.id) return;
    const data = await apiFetchJson<{ headers: string[] }>(
      `/api/projects/${encodeURIComponent(project.id)}/csv-headers?file=${encodeURIComponent(filePath)}`
    );
    setHeaders(data?.headers || []);
    setColumn('');
  }, [project?.id]);

  const send = (text: string) => {
    onSendMessage(text);
    setLastSent(text);
    if (lastSentTimer.current) clearTimeout(lastSentTimer.current);
    lastSentTimer.current = setTimeout(() => setLastSent(null), 8000);
  };

  // Phase 7 audit: Sum/Average/Count render a result card IN the panel (same aggregateColumn
  // path as the chat answer) instead of only saying "check the chat below".
  const [aggregate, setAggregate] = useState<{ op: string; value: number; count: number; column: string; file: string } | null>(null);

  const runAggregate = useCallback(async () => {
    if (!project?.id || !selectedFile || !column) return;
    setLoading(true);
    const isCount = mode === 'count';
    const params = `file=${encodeURIComponent(selectedFile)}&column=${encodeURIComponent(column)}&op=${encodeURIComponent(mode)}` +
      (isCount ? `&cmp=${encodeURIComponent(op)}&value=${encodeURIComponent(filterValue.trim())}` : '');
    const data = await apiFetchJson<{ op: string; value: number; count: number; column: string; file: string }>(
      `/api/projects/${encodeURIComponent(project.id)}/csv-aggregate?${params}`
    );
    setLoading(false);
    if (!data) { setError('Aggregate failed.'); return; }
    setError(null);
    setAggregate(data);
    setTable(null);
    send(isCount
      ? `count rows in ${selectedFile} where ${column} ${op} ${filterValue.trim()}`
      : `${mode} column ${column} in ${selectedFile}`);
  }, [project?.id, selectedFile, column, mode, op, filterValue]);

  const runFilter = useCallback(async () => {
    if (!project?.id || !selectedFile || !column || !filterValue.trim()) return;
    setLoading(true);
    const data = await apiFetchJson<{ headers: string[]; rows: string[][] }>(
      `/api/projects/${encodeURIComponent(project.id)}/csv-filter` +
      `?file=${encodeURIComponent(selectedFile)}&column=${encodeURIComponent(column)}` +
      `&op=${encodeURIComponent(op)}&value=${encodeURIComponent(filterValue.trim())}`
    );
    setLoading(false);
    if (!data) { setError('Filter failed.'); return; }
    setError(null);
    setTable(data);
    setAggregate(null);
    send(`filter ${selectedFile} where ${column} ${op} ${filterValue.trim()}`);
  }, [project?.id, selectedFile, column, op, filterValue]);

  const run = () => {
    if (!selectedFile) return;
    if (mode === 'filter') { runFilter(); return; }
    runAggregate();
  };

  const runDisabled = !selectedFile || (mode !== 'count' && mode !== 'filter' && !column) ||
    ((mode === 'count' || mode === 'filter') && (!column || !filterValue.trim()));

  // Stage C: drag-and-drop CSV upload zone with a file-picker fallback. The file is POSTed
  // to /api/projects/:id/csv-upload (project-scoped, journaled) and then selected so the
  // existing toolbar/query path works on it immediately.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  const uploadFile = async (file: File) => {
    if (!project?.id) return;
    if (!/\.csv$/i.test(file.name)) { setError('Only .csv files can be uploaded here.'); return; }
    setUploading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project.id)}/csv-upload?file=${encodeURIComponent(file.name)}`,
        { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: file }
      );
      const data = await res.json();
      if (!res.ok) { setError(data?.error || 'Upload failed.'); return; }
      await fetchFiles();
      setSelectedFile(data.path);
      fetchHeaders(data.path);
      setTable(null);
      setAggregate(null);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setUploading(false);
    }
  };

  const sortedRows = useMemo(() => {
    if (!table || sortCol === null) return table?.rows || [];
    const col = sortCol;
    const dir = sortAsc ? 1 : -1;
    return [...table.rows].sort((a, b) => {
      const na = Number(String(a[col] ?? '').replace(/[$,%\s]/g, ''));
      const nb = Number(String(b[col] ?? '').replace(/[$,%\s]/g, ''));
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return (na - nb) * dir;
      return String(a[col] ?? '').localeCompare(String(b[col] ?? '')) * dir;
    });
  }, [table, sortCol, sortAsc]);

  const toggleSort = (i: number) => {
    if (sortCol === i) setSortAsc((v) => !v);
    else { setSortCol(i); setSortAsc(true); }
  };

  const selectCls = 'text-xs bg-panel-strong border border-border-soft rounded-lg px-2.5 py-2 text-fg-strong focus:outline-none focus:border-accent/50';

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-scrim-faint rounded-lg text-accent">
              <Table size={16} />
            </div>
            <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase">Spreadsheet</h2>
            {project && <span className="text-xs text-fg-dim font-normal normal-case">— {project.name}</span>}
          </div>
          <button onClick={fetchFiles} className="p-1.5 text-fg-dim hover:text-fg-strong rounded-md transition-colors" title="Refresh">
            <RefreshCw size={15} className={cn(loading && 'animate-spin')} />
          </button>
        </div>

        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

        {!project ? (
          <div className="text-sm text-fg-muted bg-panel rounded-xl border border-border-soft p-6">
            Select a project to work with its CSV files.
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
              className={`border-2 border-dashed rounded-xl p-4 mb-3 text-center transition-colors cursor-pointer ${dragging ? 'border-accent-blue bg-accent-blue/5' : 'border-border-strong bg-background hover:border-accent-blue/50'}`}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadFile(f);
                  e.target.value = '';
                }}
              />
              <p className="text-[13px] text-fg-muted">
                {uploading ? 'Uploading…' : dragging ? 'Drop it to upload' : 'Drag & drop a CSV into this project'}
              </p>
              <button
                onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                className="mt-1.5 text-[11px] text-accent-blue hover:underline"
              >
                or pick a file…
              </button>
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-2 px-3 py-2 rounded-t-xl border border-border-soft border-b-0 bg-panel flex-wrap">
              <select value={selectedFile} onChange={(e) => { setSelectedFile(e.target.value); if (e.target.value) fetchHeaders(e.target.value); setTable(null); }} className={selectCls}>
                <option value="">Pick a CSV…</option>
                {files.map((f) => <option key={f.path} value={f.path}>{f.name}</option>)}
              </select>
              <select value={mode} onChange={(e) => { setMode(e.target.value as Mode); setTable(null); }} className={selectCls}>
                <option value="sum">Sum</option>
                <option value="average">Average</option>
                <option value="count">Count</option>
                <option value="filter">Filter</option>
              </select>
              <select value={column} onChange={(e) => setColumn(e.target.value)} className={selectCls} disabled={headers.length === 0}>
                <option value="">Column…</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
              {(mode === 'count' || mode === 'filter') && (
                <>
                  <select value={op} onChange={(e) => setOp(e.target.value)} className={selectCls}>
                    {CSV_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                  <input
                    value={filterValue}
                    onChange={(e) => setFilterValue(e.target.value)}
                    placeholder="value"
                    className="text-xs bg-panel-strong border border-border-soft rounded-lg px-2.5 py-2 text-fg-strong focus:outline-none focus:border-accent/50 w-28"
                  />
                </>
              )}
              <button onClick={run} disabled={runDisabled} className="flex items-center gap-1.5 text-xs font-medium rounded-lg px-3 py-2 bg-accent/90 text-white hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <Send size={12} /> Run
              </button>
            </div>
            <div className="px-3 py-1.5 border border-border-soft rounded-b-xl bg-scrim-faint">
              <span className="text-[11px] text-fg-dim">
                {mode === 'filter' ? 'Filter renders the table below.' : 'Result renders in the card below.'}
              </span>
              {lastSent && (
                <span className="ml-3 text-[11px] text-accent font-mono">sent: {lastSent}</span>
              )}
            </div>
          </>
        )}

        {/* Aggregate result card (Sum/Average/Count) */}
        {aggregate && (
          <div className="mt-4 rounded-xl border border-border-soft bg-panel p-4 flex items-center gap-4">
            <div className="p-2 bg-scrim-faint rounded-lg text-accent">
              <Table size={16} />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-fg-dim">
                {aggregate.op === 'sum' ? 'Sum' : aggregate.op === 'average' ? 'Average' : 'Count'} of {aggregate.column}
              </div>
              <div className="text-2xl font-semibold text-fg-strong font-mono">
                {aggregate.op === 'average' ? aggregate.value.toFixed(2) : aggregate.value.toLocaleString()}
              </div>
              <div className="text-[11px] text-fg-faint">{aggregate.file} — {aggregate.count} numeric row{aggregate.count === 1 ? '' : 's'}</div>
            </div>
          </div>
        )}

        {/* Filter result table */}
        {table && (
          <div className="mt-4 rounded-xl border border-border-soft overflow-hidden">
            <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
              <table className="w-full text-[13px] border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-panel-strong">
                    {table.headers.map((h, i) => (
                      <th key={i} onClick={() => toggleSort(i)} className="px-3 py-2 text-left text-[12px] font-semibold text-fg-strong whitespace-nowrap cursor-pointer hover:text-accent select-none border-b border-border-soft">
                        <span className="inline-flex items-center gap-1">{h}<ArrowUpDown size={11} className="text-fg-faint" /></span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row, ri) => (
                    <tr key={ri} className={cn(ri % 2 === 1 ? 'bg-panel' : 'bg-background', 'hover:bg-accent/5 transition-colors')}>
                      {row.map((cell, ci) => (
                        <td key={ci} className={cn(
                          'px-3 py-1.5 whitespace-nowrap border-b border-border-faint',
                          !Number.isNaN(Number(String(cell).replace(/[$,%\s]/g, ''))) && String(cell).trim() !== ''
                            ? 'font-mono text-right text-fg-strong'
                            : 'text-fg-muted',
                        )}>
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-3 py-1.5 text-[11px] text-fg-dim border-t border-border-soft bg-scrim-faint">
              {sortedRows.length} matching row{sortedRows.length === 1 ? '' : 's'} — click a header to sort.
            </div>
          </div>
        )}

        {files.length === 0 && project && !table && (
          <div className="mt-4 text-xs text-fg-dim italic bg-panel rounded-xl border border-border-soft p-4">
            No .csv files in this project yet. Drop one in the folder, then pick it here or type{' '}
            <code className="font-mono text-accent">sum column sales in data.csv</code> in chat.
          </div>
        )}
      </div>
    </div>
  );
}

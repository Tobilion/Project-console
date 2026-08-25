// PDF Tools merge card (2026-08-24, split out of PdfToolsPanel.tsx): the ordered multi-select
// + merge-order reorder row + output name + run button. PDF merge output depends on input
// order (a+b+c != a+c+b), so the selection is an ordered array.

import { ChevronUp, ChevronDown, Send, FileText, Download, FolderOpen, CheckCircle2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { EmptyState } from '../ui/EmptyState';
import { formatSize } from './utils';
import type { PdfFileInfo } from './utils';

export interface MergeCardProps {
  files: PdfFileInfo[];
  mergeOrder: string[];
  mergeOutput: string;
  card: string;
  inputCls: string;
  runBtn: string;
  onToggle: (name: string) => void;
  onMove: (idx: number, dir: -1 | 1) => void;
  onOutputChange: (v: string) => void;
  onMerge: () => void;
  mergeDisabled: boolean;
}

export function MergeCard(props: MergeCardProps) {
  const { files, mergeOrder, mergeOutput, card, inputCls, runBtn, onToggle, onMove, onOutputChange, onMerge, mergeDisabled } = props;

  return (
    <div className={card}>
      <h3 className="text-xs font-semibold text-fg-strong mb-3">Merge PDFs</h3>
      <div className="flex flex-wrap gap-2 mb-3 max-h-28 overflow-y-auto">
        {files.length === 0 && <span className="text-xs text-fg-dim italic">No PDFs to pick.</span>}
        {files.map((f) => {
          const on = mergeOrder.includes(f.name);
          return (
            <button
              key={f.path}
              onClick={() => onToggle(f.name)}
              className={cn(
                'text-[11px] px-2 py-1 rounded-lg border transition-colors',
                on
                  ? 'bg-accent-blue/15 border-accent-blue/50 text-accent-blue'
                  : 'bg-scrim-faint border-border-soft text-fg-muted hover:border-accent-blue/30'
              )}
            >
              {f.name}
            </button>
          );
        })}
      </div>
      {mergeOrder.length > 0 && (
        <div className="mb-3 space-y-1 max-h-28 overflow-y-auto">
          <p className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold">
            Merge order ({mergeOrder.length})
          </p>
          {mergeOrder.map((name, i) => (
            <div key={name} className="flex items-center gap-1.5 text-[11px]">
              <span className="w-4 text-right text-fg-faint font-mono">{i + 1}</span>
              <span className="flex-1 min-w-0 truncate font-mono text-fg-strong">{name}</span>
              <button
                onClick={() => onMove(i, -1)}
                disabled={i === 0}
                aria-label={`Move ${name} up`}
                className="p-0.5 text-fg-dim hover:text-fg-strong disabled:opacity-30 transition-colors"
              >
                <ChevronUp size={12} />
              </button>
              <button
                onClick={() => onMove(i, 1)}
                disabled={i === mergeOrder.length - 1}
                aria-label={`Move ${name} down`}
                className="p-0.5 text-fg-dim hover:text-fg-strong disabled:opacity-30 transition-colors"
              >
                <ChevronDown size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={mergeOutput}
          onChange={(e) => onOutputChange(e.target.value)}
          placeholder="combined.pdf"
          className={cn(inputCls, 'flex-1')}
        />
        <button onClick={onMerge} disabled={mergeDisabled} className={cn(runBtn, '!mt-0 w-auto px-4')}>
          <Send size={12} /> Merge
        </button>
      </div>
      {mergeOrder.length === 1 && (
        <p className="text-[11px] text-fg-dim mt-1.5">Pick at least one more PDF to merge.</p>
      )}
    </div>
  );
}

/** Project PDF file list with per-file download + reveal + the "sent" notice. */
export function PdfFileList({ files, loading, error, lastSent, card, smallBtn, fileUrl, onReveal }: {
  files: PdfFileInfo[];
  loading: boolean;
  error: string | null;
  lastSent: string | null;
  card: string;
  smallBtn: string;
  fileUrl: (path: string) => string;
  onReveal: (path: string) => void;
}) {
  return (
    <div className={cn(card, 'lg:col-span-2')}>
      <h3 className="text-xs font-semibold text-fg-strong mb-2">Project PDFs</h3>
      {error && <p className="text-xs text-accent-red mb-2">{error}</p>}
      {files.length === 0 ? (
        <EmptyState
          icon={<FileText size={18} />}
          title={loading ? 'Scanning…' : 'No PDFs in this project'}
          hint="Drop some into the folder, or type merge pdfs in chat to open this panel from the terminal."
          className="py-6"
        />
      ) : (
        <ul className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
          {files.map((f) => (
            <li key={f.path} className="flex items-center gap-1.5 text-xs bg-scrim-faint rounded-lg px-2 py-1.5">
              <FileText size={13} className="text-fg-dim shrink-0" />
              <span className="text-fg-strong truncate flex-1" title={f.path}>{f.name}</span>
              <span className="text-fg-dim text-[10px] shrink-0">{formatSize(f.size)}</span>
              <a href={fileUrl(f.path)} download={f.name} className={smallBtn} title="Download">
                <Download size={13} />
              </a>
              <button onClick={() => onReveal(f.path)} className={smallBtn} title="Show in folder">
                <FolderOpen size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {lastSent && (
        <div className="mt-3 flex items-start gap-2 text-[11px] text-fg-muted bg-scrim-faint border border-border-soft rounded-lg p-2.5">
          <CheckCircle2 size={13} className="text-accent mt-0.5 shrink-0" />
          <span>
            Sent <code className="font-mono text-accent">{lastSent}</code> — confirm or
            follow the result in the chat below.
          </span>
        </div>
      )}
    </div>
  );
}
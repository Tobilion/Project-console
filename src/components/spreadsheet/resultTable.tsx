// Spreadsheet sortable result table (2026-08-24, split out of SpreadsheetPanel.tsx).
// Shared by the filter result and the file preview so both stay in lockstep.

import { ArrowUpDown } from 'lucide-react';
import { cn } from '../../lib/utils';

export function ResultTable({ headers, rows, sortCol, sortAsc, onToggleSort, footer }: {
  headers: string[];
  rows: string[][];
  sortCol: number | null;
  sortAsc: boolean;
  onToggleSort: (i: number) => void;
  footer: React.ReactNode;
}) {
  return (
    <div className="mt-4 rounded-xl border border-border-soft overflow-hidden">
      <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-panel-strong">
              {headers.map((h, i) => (
                <th key={i} className="px-3 py-2 text-left text-[12px] font-semibold text-fg-strong whitespace-nowrap border-b border-border-soft">
                  <button onClick={() => onToggleSort(i)} className="inline-flex items-center gap-1 cursor-pointer hover:text-accent select-none">
                    {h}<ArrowUpDown size={11} className="text-fg-faint" />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              // Content-derived identity: the table re-sorts live, so positional keys
              // would make React reuse the wrong DOM rows across sort changes.
              <tr key={row.map((cell) => String(cell)).join('\u0001')} className={cn(ri % 2 === 1 ? 'bg-panel' : 'bg-background', 'hover:bg-accent/5 transition-colors')}>
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
        {footer}
      </div>
    </div>
  );
}
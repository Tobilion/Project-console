// PDF Tools shared helpers (2026-08-24, split out of PdfToolsPanel.tsx): types + formatting.

export interface PdfFileInfo {
  name: string;
  path: string;
  size: number;
}

export function formatSize(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

/** Output filenames are composed here and the server re-validates them anyway — strip path
 *  separators and shell-hostile characters so a stray keystroke can't corrupt the command,
 *  and ensure the .pdf suffix (the chat commands assume it). */
export function sanitizeOutputName(raw: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, '').trim();
  if (!cleaned) return '';
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`;
}
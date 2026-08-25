// File Tools shared helpers (2026-08-24, split out of FileToolsPanel.tsx): types +
// formatting + icon mapping.

import { File, FileCode, FileText, FileImage, FileArchive, Table, Music, Video, Code } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: number;
}

export interface SearchResult {
  path: string;
  size: number;
  modifiedAt: number;
}

export interface DuplicateGroup {
  hash: string;
  files: { path: string; size: number; modifiedAt: number }[];
  keepPath: string;
  waste: number;
}

export function formatSize(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fileIcon(name: string, size = 14) {
  const ext = name.toLowerCase().split('.').pop() || '';
  const cls = 'shrink-0 text-fg-dim';
  if (['py', 'js', 'jsx', 'ts', 'tsx', 'c', 'cpp', 'h', 'hpp', 'java', 'cs', 'kt', 'go', 'rs', 'rb', 'php', 'swift', 'sh', 'ps1'].includes(ext)) return <FileCode size={size} className={cn(cls, 'text-accent-blue/80')} />;
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return <FileImage size={size} className={cls} />;
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'].includes(ext)) return <Music size={size} className={cls} />;
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) return <Video size={size} className={cls} />;
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz'].includes(ext)) return <FileArchive size={size} className={cls} />;
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return <Table size={size} className={cls} />;
  if (['html', 'htm'].includes(ext)) return <Code size={size} className={cn(cls, 'text-accent-orange/80')} />;
  if (['txt', 'md', 'json', 'yml', 'yaml', 'xml', 'log'].includes(ext)) return <FileText size={size} className={cls} />;
  return <File size={size} className={cls} />;
}
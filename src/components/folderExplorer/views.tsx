// Folder Explorer list-row + grid-tile renderers (2026-08-24, split out of
// FolderExplorerPanel.tsx). Pure presentational components: every interaction is a callback
// prop, so the parent keeps all state.

import { Folder } from 'lucide-react';
import { cn } from '../../lib/utils';
import { fileIcon, formatSize, formatDate, extOf } from './utils';
import type { BrowseEntry, EditorDef } from './utils';
import { EntryMenu } from './menus';

export interface EntryRowProps {
  entry: BrowseEntry;
  index: number;
  cursor: number;
  selected: boolean;
  /** Parent's current drop-target path (null when none) — the row highlights when it matches. */
  dropTargetPath: string | null;
  renaming: boolean;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  editors: EditorDef[];
  canRename: boolean;
  onBrowse: (path: string) => void;
  onOpenDefault: (path: string) => void;
  onToggleSelect: (entry: BrowseEntry, ev: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent, entry: BrowseEntry) => void;
  onDrop: (e: React.DragEvent, target: BrowseEntry) => void;
  onSetDropTarget: (path: string | null) => void;
  onContextMenu: (ev: React.MouseEvent, entry: BrowseEntry) => void;
  onStartRename: (entry: BrowseEntry) => void;
  onCommitRename: (entry: BrowseEntry) => void;
  onCancelRename: () => void;
  onBlurRename: (entry: BrowseEntry) => void;
  onRenameValue: (value: string) => void;
  onSendMessage: (text: string) => void;
  onOpenWith: (path: string) => void;
}

export function EntryRow(props: EntryRowProps) {
  const {
    entry: e, index: i, cursor, selected, dropTargetPath, renaming, renameValue, renameInputRef,
    editors, canRename, onBrowse, onOpenDefault, onToggleSelect, onDragStart, onDrop,
    onSetDropTarget, onContextMenu, onStartRename, onCommitRename, onCancelRename,
    onBlurRename, onRenameValue, onSendMessage, onOpenWith,
  } = props;

  const dropTarget = dropTargetPath === e.path;

  return (
    <tr
      key={e.path}
      data-explorer-cursor={i === cursor ? '' : undefined}
      onContextMenu={(ev) => { ev.preventDefault(); onContextMenu(ev, e); }}
      onDragOver={(ev) => { if (e.isDir) { ev.preventDefault(); onSetDropTarget(e.path); } }}
      onDragLeave={() => { if (dropTarget) onSetDropTarget(null); }}
      onDrop={(ev) => { if (e.isDir) onDrop(ev, e); }}
      className={cn(
        'border-b border-border-faint last:border-b-0 hover:bg-scrim-faint transition-colors',
        i === cursor && 'bg-accent-blue/10 hover:bg-accent-blue/15',
        selected && 'bg-accent-blue/15 hover:bg-accent-blue/20',
        dropTarget && 'bg-accent-green/10',
      )}
    >
      <td className="px-4 py-1.5">
        {renaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(ev) => onRenameValue(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') { ev.preventDefault(); onCommitRename(e); }
              else if (ev.key === 'Escape') { ev.preventDefault(); onCancelRename(); }
            }}
            onBlur={() => onBlurRename(e)}
            aria-label={`Rename ${e.name}`}
            className="w-full text-xs font-mono bg-panel-strong border border-accent-blue/50 rounded px-1.5 py-0.5 text-fg-strong focus:outline-none"
          />
        ) : (
          <button
            draggable={!e.isDir}
            onDragStart={(ev) => onDragStart(ev, e)}
            onClick={(ev) => {
              if (ev.ctrlKey || ev.metaKey || ev.shiftKey) { onToggleSelect(e, ev); return; }
              if (e.isDir) onBrowse(e.path);
            }}
            onDoubleClick={() => { if (!e.isDir) onOpenDefault(e.path); }}
            onKeyDown={(ev) => {
              // Enter on a row opens it: folders navigate, files open in the default app.
              if (ev.key === 'Enter') {
                ev.preventDefault();
                if (e.isDir) onBrowse(e.path);
                else onOpenDefault(e.path);
              }
            }}
            title={e.isDir ? 'Enter to open folder · right-click for more' : 'Double-click or Enter to open in its default app · Ctrl+click to multi-select · drag onto a folder to move'}
            className="flex items-center gap-2 text-left w-full cursor-pointer"
          >
            {e.isDir ? <Folder size={14} className="shrink-0 text-accent" /> : fileIcon(e.name)}
            <span className="text-fg-strong font-mono truncate">{e.name}</span>
          </button>
        )}
      </td>
      <td className="px-2 py-1.5 text-right text-fg-dim font-mono hidden sm:table-cell">{e.isDir ? '—' : formatSize(e.size)}</td>
      <td className="px-4 py-1.5 text-right text-fg-dim hidden md:table-cell">{formatDate(e.modifiedAt)}</td>
      <td className="px-2 py-1.5">
        <EntryMenu
          entry={e}
          editors={editors}
          onSendMessage={onSendMessage}
          onOpenWith={() => onOpenWith(e.path)}
          onOpenDefault={() => { if (!e.isDir) onOpenDefault(e.path); }}
          onRename={() => onStartRename(e)}
          canRename={canRename}
        />
      </td>
    </tr>
  );
}

export interface EntryTileProps extends Omit<EntryRowProps, 'canRename' | 'editors' | 'onSendMessage' | 'onOpenWith'> {
  tileIconSize: number;
}

export function EntryTile(props: EntryTileProps) {
  const {
    entry: e, index: i, cursor, selected, dropTargetPath, renaming, renameValue, renameInputRef,
    tileIconSize, onBrowse, onOpenDefault, onToggleSelect, onDragStart, onDrop, onSetDropTarget,
    onContextMenu, onCommitRename, onCancelRename, onBlurRename, onRenameValue,
  } = props;

  const dropTarget = dropTargetPath === e.path;

  return renaming ? (
    <div
      key={e.path}
      className="flex items-center justify-center rounded-xl border border-accent-blue/50 bg-accent-blue/10 p-2"
    >
      <input
        ref={renameInputRef}
        value={renameValue}
        onChange={(ev) => onRenameValue(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); onCommitRename(e); }
          else if (ev.key === 'Escape') { ev.preventDefault(); onCancelRename(); }
        }}
        onBlur={() => onBlurRename(e)}
        aria-label={`Rename ${e.name}`}
        className="w-full text-[10px] font-mono bg-panel-strong border border-accent-blue/50 rounded px-1.5 py-0.5 text-fg-strong focus:outline-none"
      />
    </div>
  ) : (
    <button
      key={e.path}
      data-explorer-cursor={i === cursor ? '' : undefined}
      onContextMenu={(ev) => { ev.preventDefault(); onContextMenu(ev, e); }}
      onDragOver={(ev) => { if (e.isDir) { ev.preventDefault(); onSetDropTarget(e.path); } }}
      onDragLeave={() => { if (dropTarget) onSetDropTarget(null); }}
      onDrop={(ev) => { if (e.isDir) onDrop(ev, e); }}
      draggable={!e.isDir}
      onDragStart={(ev) => onDragStart(ev, e)}
      onClick={(ev) => {
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey) { onToggleSelect(e, ev); return; }
        if (e.isDir) onBrowse(e.path);
      }}
      onDoubleClick={() => { if (!e.isDir) onOpenDefault(e.path); }}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          if (e.isDir) onBrowse(e.path);
          else onOpenDefault(e.path);
        }
      }}
      title={e.isDir ? 'Enter to open folder · drop files here to move them into it' : 'Double-click or Enter to open in its default app · Ctrl+click to multi-select · drag onto a folder to move'}
      className={cn(
        'group flex flex-col items-center gap-1.5 rounded-xl border p-2 transition-colors cursor-pointer',
        i === cursor
          ? 'border-accent-blue/50 bg-accent-blue/10'
          : 'border-transparent',
        selected && 'border-accent-blue/40 bg-accent-blue/15',
        dropTarget && 'border-accent-green/60 bg-accent-green/10',
        e.isDir ? 'hover:bg-scrim-faint hover:border-border-soft' : 'hover:bg-scrim-faint',
      )}
    >
      <div className="flex flex-col items-center gap-1">
        {e.isDir ? <Folder size={tileIconSize} className="text-accent" /> : fileIcon(e.name, tileIconSize)}
        {!e.isDir && (
          <span className="text-[9px] text-fg-faint font-mono uppercase">{extOf(e.name) || 'file'}</span>
        )}
      </div>
      <span className="text-[10px] text-fg-strong text-center break-all leading-tight max-h-8 overflow-hidden">
        {e.name}
      </span>
    </button>
  );
}
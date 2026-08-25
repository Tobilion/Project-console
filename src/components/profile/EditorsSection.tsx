// Editors & IDEs registry editor (2026-08-24, split out of UserProfileModal.tsx).
// Self-contained: fetches GET /api/editors on mount, POSTs the whole registry on Save.
// "open X with <editor>" in chat uses this registry (server/editorsStore.js).

import { useState, useEffect, useRef } from 'react';
import { Code, Plus, Trash2, Save } from 'lucide-react';
import { apiFetchJson } from '../../utils/apiFetch';

// Phase T2 (2026-08-14): the editor/IDE registry shape from GET /api/editors.
interface EditorsState {
  editors: { id: string; name: string; command: string }[];
  defaults: Record<string, string>;
}

const EXT_DEFAULT_HINTS: [string, string][] = [
  ['.py', 'Python'], ['.java', 'Java'], ['.js', 'JavaScript'], ['.ts', 'TypeScript'],
  ['.c', 'C'], ['.cpp', 'C++'], ['.cs', 'C#'], ['.kt', 'Kotlin'], ['.html', 'HTML'],
  ['.md', 'Markdown'], ['.json', 'JSON'], ['.css', 'CSS'],
];

export function EditorsSection() {
  const [editors, setEditors] = useState<EditorsState | null>(null);
  const [editorsDirty, setEditorsDirty] = useState(false);
  const [editorsSaved, setEditorsSaved] = useState(false);
  const editorsSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear the "editors saved" timer on unmount so its delayed setState can't fire on a dead
  // modal (and hold its closure alive after it unmounted).
  useEffect(() => () => { if (editorsSavedTimer.current) clearTimeout(editorsSavedTimer.current); }, []);

  useEffect(() => {
    apiFetchJson<EditorsState>('/api/editors').then((e) => {
      if (e) setEditors(e);
    });
    setEditorsDirty(false);
    setEditorsSaved(false);
  }, []);

  const handleSaveEditors = async () => {
    if (!editors) return;
    const res = await apiFetchJson<EditorsState>('/api/editors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editors: editors.editors, defaults: editors.defaults }),
    });
    if (res) {
      setEditors(res);
      setEditorsDirty(false);
      setEditorsSaved(true);
      if (editorsSavedTimer.current) clearTimeout(editorsSavedTimer.current);
      editorsSavedTimer.current = setTimeout(() => setEditorsSaved(false), 2000);
    }
  };

  const mutateEditors = (fn: (e: EditorsState) => EditorsState) => {
    if (!editors) return;
    setEditors(fn(editors));
    setEditorsDirty(true);
  };

  return (
    <div className="pt-2 border-t border-border-faint">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Code size={13} className="text-accent-blue" />
        <p className="text-sm text-fg">Editors &amp; IDEs</p>
      </div>
      <p className="text-[11px] text-fg-dim mb-2">
        Which editors open your files — "open main.py with PyCharm" in chat, or "open X in
        the editor" uses the per-extension default below. The command is launched with the
        file path as its argument.
      </p>
      {editors ? (
        <>
          <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
            {editors.editors.map((ed) => (
              <div key={ed.id} className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-[11px] text-fg-strong truncate" title={ed.name}>{ed.name}</span>
                <input
                  type="text"
                  value={ed.command}
                  onChange={(e) => mutateEditors((s) => ({
                    ...s,
                    editors: s.editors.map((x) => x.id === ed.id ? { ...x, command: e.target.value } : x),
                  }))}
                  className="flex-1 min-w-0 bg-surface border border-border-soft rounded-lg px-2 py-1 text-[11px] font-mono text-fg focus:outline-none focus:border-accent-blue transition-colors"
                  placeholder="launch command (e.g. code)"
                />
                <button
                  type="button"
                  onClick={() => mutateEditors((s) => ({
                    ...s,
                    editors: s.editors.filter((x) => x.id !== ed.id),
                    defaults: Object.fromEntries(Object.entries(s.defaults).filter(([, v]) => v !== ed.id)),
                  }))}
                  className="p-1 text-fg-dim hover:text-accent-red transition-colors"
                  title={`Remove ${ed.name}`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => mutateEditors((s) => ({
              ...s,
              editors: [...s.editors, { id: `custom-${Date.now().toString(36)}`, name: 'New editor', command: '' }],
            }))}
            className="mt-1.5 flex items-center gap-1 px-2 py-1 text-[11px] text-accent-blue hover:bg-accent-blue/10 rounded-lg transition-colors"
          >
            <Plus size={12} /> Add editor
          </button>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
            {EXT_DEFAULT_HINTS.map(([ext, label]) => (
              <div key={ext} className="flex items-center gap-1.5">
                <span className="w-12 shrink-0 text-[10px] text-fg-dim font-mono">{ext}</span>
                <select
                  value={editors.defaults[ext] || 'vscode'}
                  onChange={(e) => mutateEditors((s) => ({
                    ...s,
                    defaults: { ...s.defaults, [ext]: e.target.value },
                  }))}
                  className="flex-1 min-w-0 bg-surface border border-border-soft rounded-lg px-1.5 py-0.5 text-[11px] text-fg-muted focus:outline-none focus:border-accent-blue transition-colors"
                >
                  {editors.editors.map((ed) => <option key={ed.id} value={ed.id}>{ed.name}</option>)}
                  <option value="browser">Browser</option>
                </select>
                <span className="text-[9px] text-fg-faint">{label}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={handleSaveEditors}
              disabled={!editorsDirty}
              className="flex items-center gap-1 px-3 py-1.5 text-[10px] font-bold tracking-wider uppercase rounded-lg bg-accent-blue/15 text-accent-blue hover:bg-accent-blue/25 transition-colors disabled:opacity-40"
            >
              <Save size={11} /> Save editors
            </button>
            {editorsSaved && <span className="text-[10px] text-accent-green">Saved — affects the next "open with"</span>}
          </div>
        </>
      ) : (
        <p className="text-[11px] text-fg-dim italic">Loading editors…</p>
      )}
    </div>
  );
}
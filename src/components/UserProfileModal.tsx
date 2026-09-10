import React, { useState, useEffect } from 'react';
import { UserProfile } from '../hooks/useUserProfile';
import { Settings, X, LayoutGrid, List, Compass, User, Users, Palette, Shield, Bell, Sparkles, HelpCircle } from 'lucide-react';
import { ModalShell } from './ui/ModalShell';
import { UsersSection } from './profile/UsersSection';
import { EditorsSection } from './profile/EditorsSection';
import { TuningSection } from './profile/TuningSection';
import { TOUR_GROUPS, TOUR_SECTIONS } from '../tours';

interface UserProfileModalProps {
  open: boolean;
  profile: UserProfile;
  onClose: () => void;
  onSave: (updates: Partial<UserProfile>) => void;
  /** Phase 4.1: when set, opens the modal at a specific category and scrolls to the target field. */
  initialCategory?: string;
  scrollToField?: string;
  /** Portal (2026-09-10): drives the Users category — visible when disarmed (first-admin
    onboarding) or to admins; hidden for armed non-admins. Defaults keep every existing
    caller (none pass these) on today's category set. */
  authArmed?: boolean;
  authRole?: string | null;
}

const CATEGORIES = [
  { id: 'identity', label: 'Identity', icon: User },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'reminders', label: 'Reminders & Notifications', icon: Bell },
  { id: 'privacy', label: 'Privacy & Security', icon: Shield },
  { id: 'advanced', label: 'Advanced', icon: Sparkles },
  { id: 'help', label: 'Help & Tours', icon: HelpCircle },
  { id: 'users', label: 'Users', icon: Users },
] as const;

type CategoryId = typeof CATEGORIES[number]['id'];

const ACCENT_PRESETS: { label: string; value: string }[] = [
  { label: 'Blue', value: '#0A84FF' },
  { label: 'Purple', value: '#BF5AF2' },
  { label: 'Pink', value: '#FF375F' },
  { label: 'Red', value: '#FF453A' },
  { label: 'Orange', value: '#FF9F0A' },
  { label: 'Yellow', value: '#FFD60A' },
  { label: 'Green', value: '#30D158' },
  { label: 'Graphite', value: '#8E8E93' },
];

const Toggle = ({ enabled, onToggle, title }: { enabled: boolean; onToggle: () => void; title: string }) => (
  <button
    type="button"
    role="switch"
    aria-checked={enabled}
    onClick={onToggle}
    className={`relative shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors ${enabled ? 'bg-accent-blue' : 'bg-panel border border-border-soft'}`}
    title={title}
  >
    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : ''}`} />
  </button>
);

const FieldLabel = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div className="space-y-1.5">
    <label className="block text-xs text-fg-dim font-medium">{label}</label>
    {children}
    {hint && <p className="text-[10px] text-fg-dim leading-relaxed">{hint}</p>}
  </div>
);

/** Gear-triggered settings editor with Windows Settings-style left category sidebar.
 *  Phase 2.1 (2026-09-07): restructured from a flat list into categorized sections so users
 *  don't get lost scrolling through 20+ toggles and fields. Identity is the hero. */
export function UserProfileModal({ open, profile, onClose, onSave, initialCategory, scrollToField, authArmed = false, authRole = null }: UserProfileModalProps) {
  // Portal Users category: everyone while disarmed (onboarding), admins once armed.
  const showUsers = !authArmed || authRole === 'admin';
  const [name, setName] = useState(profile.name);
  const [title, setTitle] = useState(profile.title);
  const [customRole, setCustomRole] = useState(profile.customRole);
  const [sandboxRiskyCommands, setSandboxRiskyCommands] = useState(profile.sandboxRiskyCommands);
  const [clipboardHistory, setClipboardHistory] = useState(profile.clipboardHistory);
  const [clipboardPersist, setClipboardPersist] = useState(profile.clipboardPersist);
  const [scanAllFolders, setScanAllFolders] = useState(profile.scanAllFolders);
  const [explorerViewMode, setExplorerViewMode] = useState<'list' | 'grid'>(profile.explorerViewMode);
  const [defaultWorkspaceType, setDefaultWorkspaceType] = useState<'dev' | 'general'>(profile.defaultWorkspaceType === 'general' ? 'general' : 'dev');
  const [locale, setLocale] = useState(profile.locale === 'de' ? 'de' : 'en');
  const [permissionMode, setPermissionMode] = useState<'default' | 'ask'>(profile.permissionMode === 'ask' ? 'ask' : 'default');
  const [persistRemindersAcrossRestart, setPersistRemindersAcrossRestart] = useState(profile.persistRemindersAcrossRestart);
  const [reminderToastDurationMs, setReminderToastDurationMs] = useState(profile.reminderToastDurationMs);
  const [reminderToastPosition, setReminderToastPosition] = useState(profile.reminderToastPosition);
  const [askBeforeDeleteLinkedNote, setAskBeforeDeleteLinkedNote] = useState(profile.askBeforeDeleteLinkedNote);
  const [aiRedirectDelayMs, setAiRedirectDelayMs] = useState(profile.aiRedirectDelayMs);
  const [quietStart, setQuietStart] = useState(profile.quietHoursStart === null ? 'off' : String(profile.quietHoursStart));
  const [quietEnd, setQuietEnd] = useState(profile.quietHoursEnd === null ? 'off' : String(profile.quietHoursEnd));
  const [colorFollowsMouse, setColorFollowsMouse] = useState(profile.colorFollowsMouse);
  const [liquidGlass, setLiquidGlass] = useState(profile.liquidGlass);
  const [glassIntensity, setGlassIntensity] = useState(
    typeof profile.glassIntensity === 'number' ? profile.glassIntensity : 65);
  const [glassScope, setGlassScope] = useState<'buttons' | 'cards' | 'all'>(
    profile.glassScope === 'buttons' || profile.glassScope === 'all' ? profile.glassScope : 'cards');
  const [generalToolsFirst, setGeneralToolsFirst] = useState(profile.generalToolsFirst);
  const [category, setCategory] = useState<CategoryId>((initialCategory as CategoryId) || 'identity');

  const [hexDraft, setHexDraft] = useState('');
  const hexValid = /^[0-9a-fA-F]{6}$/.test(hexDraft);
  const applyAccent = (value: string) => onSave({ accentColor: value });

  const [tourSection, setTourSection] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(profile.name);
      setTitle(profile.title);
      setCustomRole(profile.customRole);
      setSandboxRiskyCommands(profile.sandboxRiskyCommands);
      setClipboardHistory(profile.clipboardHistory);
      setClipboardPersist(profile.clipboardPersist);
      setScanAllFolders(profile.scanAllFolders);
      setExplorerViewMode(profile.explorerViewMode === 'grid' ? 'grid' : 'list');
      setDefaultWorkspaceType(profile.defaultWorkspaceType === 'general' ? 'general' : 'dev');
      setLocale(profile.locale === 'de' ? 'de' : 'en');
      setPermissionMode(profile.permissionMode === 'ask' ? 'ask' : 'default');
      setPersistRemindersAcrossRestart(profile.persistRemindersAcrossRestart);
      setReminderToastDurationMs(profile.reminderToastDurationMs);
      setReminderToastPosition(profile.reminderToastPosition);
      setAskBeforeDeleteLinkedNote(profile.askBeforeDeleteLinkedNote);
      setAiRedirectDelayMs(profile.aiRedirectDelayMs);
      setQuietStart(profile.quietHoursStart === null ? 'off' : String(profile.quietHoursStart));
      setQuietEnd(profile.quietHoursEnd === null ? 'off' : String(profile.quietHoursEnd));
      setColorFollowsMouse(profile.colorFollowsMouse);
      setLiquidGlass(profile.liquidGlass);
      setGlassIntensity(typeof profile.glassIntensity === 'number' ? profile.glassIntensity : 65);
      setGlassScope(profile.glassScope === 'buttons' || profile.glassScope === 'all' ? profile.glassScope : 'cards');
      setGeneralToolsFirst(profile.generalToolsFirst);
      if (initialCategory) setCategory(initialCategory as CategoryId);
    }
  }, [open, profile, initialCategory]);

  // Phase 4.1: scroll-to-field support after category switch.
  useEffect(() => {
    if (scrollToField) {
      const timer = setTimeout(() => {
        const el = document.querySelector(`[data-setting="${scrollToField}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el?.classList.add('ring-2', 'ring-accent-blue', 'ring-offset-2', 'ring-offset-background', 'rounded-lg');
        setTimeout(() => el?.classList.remove('ring-2', 'ring-accent-blue', 'ring-offset-2', 'ring-offset-background', 'rounded-lg'), 2000);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [scrollToField, category]);

  const canSave = name.trim() && title.trim() && customRole.trim();
  const [showErrors, setShowErrors] = useState(false);

  const handleSave = () => {
    if (!canSave) { setShowErrors(true); return; }
    onSave({
      name: name.trim(), title: title.trim(), customRole: customRole.trim(),
      sandboxRiskyCommands, clipboardHistory, clipboardPersist, scanAllFolders,
      explorerViewMode, defaultWorkspaceType, locale, permissionMode, persistRemindersAcrossRestart,
      reminderToastDurationMs, reminderToastPosition, askBeforeDeleteLinkedNote,
      aiRedirectDelayMs, generalToolsFirst,
      quietHoursStart: quietStart === 'off' ? null : Number(quietStart),
      quietHoursEnd: quietEnd === 'off' ? null : Number(quietEnd),
      colorFollowsMouse,
      liquidGlass,
      glassIntensity,
      glassScope,
    });
    onClose();
  };

  const fieldError = (value: string) => showErrors && !value.trim();

  const launchTour = (id: string) => {
    window.dispatchEvent(new CustomEvent('lpc:launch-tour', { detail: { section: id } }));
    setTourSection(id);
  };

  const toursTaken = (() => {
    try { return JSON.parse(localStorage.getItem('console.toursTaken') || '{}'); } catch { return {}; }
  })();

  const sectionCls = 'bg-panel rounded-xl border border-border-faint p-4';
  const inputCls = 'w-full bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent-blue transition-colors';

  return (
    <ModalShell open={open} onClose={onClose} maxWidth="max-w-3xl">
      <div className="flex min-h-[520px]">
        {/* Left category sidebar — Windows Settings reference */}
        <div className="w-52 shrink-0 border-r border-border-faint bg-overlay/50 flex flex-col p-3 gap-0.5">
          <div className="flex items-center gap-2 px-2 py-2 mb-2">
            <Settings size={16} className="text-fg-dim" />
            <span className="text-xs font-bold tracking-wider uppercase text-fg-dim">Settings</span>
          </div>
          {CATEGORIES.filter((cat) => cat.id !== 'users' || showUsers).map((cat) => {
            const Icon = cat.icon;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => setCategory(cat.id)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12px] transition-colors text-left ${
                  category === cat.id
                    ? 'bg-accent-blue/15 text-accent-blue font-semibold'
                    : 'text-fg-muted hover:text-fg-strong hover:bg-scrim-faint'
                }`}
              >
                <Icon size={14} />
                <span className="truncate">{cat.label}</span>
              </button>
            );
          })}
        </div>

        {/* Right content area */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
          {/* ─── IDENTITY (the hero) ─────────────────────────────────────── */}
          {category === 'identity' && (
            <>
              <div className="flex items-center gap-2 mb-1">
                <User size={18} className="text-accent-blue" />
                <h3 className="text-lg font-bold text-fg-strong">Your Identity</h3>
              </div>
              <p className="text-[11px] text-fg-dim mb-3">How the console addresses you and personalizes greetings.</p>

              <div className={sectionCls} data-setting="name">
                <FieldLabel label="Name" hint="Used in greetings like 'Good evening, {name}'">
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                    placeholder="Your name"
                    className={`${inputCls} ${fieldError(name) ? 'border-accent-red' : ''}`}
                  />
                  {fieldError(name) && <p className="text-[10px] text-accent-red mt-1">Name is required.</p>}
                </FieldLabel>
              </div>

              <div className={sectionCls} data-setting="title">
                <FieldLabel label="Title" hint="Optional honorific or preference">
                  <input
                    type="text"
                    list="lpc-titles"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Master (or 'none')"
                    className={`${inputCls} ${fieldError(title) ? 'border-accent-red' : ''}`}
                  />
                  {fieldError(title) && <p className="text-[10px] text-accent-red mt-1">Title is required — type "none" if you don't use one.</p>}
                  <datalist id="lpc-titles">
                    <option value="Master" /><option value="Engineer" /><option value="Dev" />
                    <option value="Dr." /><option value="None" />
                  </datalist>
                </FieldLabel>
              </div>

              <div className={sectionCls} data-setting="customRole">
                <FieldLabel label="Custom Role" hint="Your professional role or title">
                  <input
                    type="text"
                    value={customRole}
                    onChange={(e) => setCustomRole(e.target.value)}
                    placeholder="e.g. Software Engineer"
                    className={`${inputCls} ${fieldError(customRole) ? 'border-accent-red' : ''}`}
                  />
                  {fieldError(customRole) && <p className="text-[10px] text-accent-red mt-1">Custom role is required — type a role or "none".</p>}
                </FieldLabel>
              </div>
            </>
          )}

          {/* ─── APPEARANCE ─────────────────────────────────────────────── */}
          {category === 'appearance' && (
            <>
              <div className="flex items-center gap-2 mb-1">
                <Palette size={18} className="text-accent-blue" />
                <h3 className="text-lg font-bold text-fg-strong">Appearance</h3>
              </div>

              <div className={sectionCls}>
                <FieldLabel label="Accent Color" hint="Applies everywhere accent-blue is used (active tab, buttons, selection). Semantic colors (teal/orange/green/red) are not affected.">
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => applyAccent('auto')} title="Auto"
                      className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 ${profile.accentColor === 'auto' ? 'border-fg-strong' : 'border-border-soft'}`}
                      style={{ background: 'linear-gradient(135deg, #0D0D0E 50%, #F2F2F7 50%)' }}>
                      <span className="block w-2.5 h-2.5 mx-auto rounded-full" style={{ background: 'var(--color-accent-blue)' }} />
                    </button>
                    {ACCENT_PRESETS.map((p) => (
                      <button key={p.value} type="button" onClick={() => applyAccent(p.value)} title={p.label}
                        className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 ${profile.accentColor === p.value ? 'border-fg-strong' : 'border-border-soft'}`}
                        style={{ backgroundColor: p.value }} />
                    ))}
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <input type="text" value={hexDraft ? `#${hexDraft}` : ''}
                      onChange={(e) => setHexDraft(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6))}
                      onKeyDown={(e) => { if (e.key === 'Enter' && hexValid) applyAccent(`#${hexDraft}`); }}
                      placeholder="#RRGGBB — custom color"
                      className="w-40 bg-surface border border-border-soft rounded-lg px-3 py-1.5 text-xs font-mono text-fg focus:outline-none focus:border-accent-blue transition-colors" />
                    <button type="button" onClick={() => applyAccent(`#${hexDraft}`)} disabled={!hexValid}
                      className="px-3 py-1.5 text-[10px] font-bold tracking-wider uppercase rounded-lg bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed">Apply</button>
                    <span className="text-[10px] text-fg-dim">6 hex digits</span>
                  </div>
                </FieldLabel>
              </div>

              <div className={sectionCls} data-setting="explorerViewMode">
                <FieldLabel label="Folder Explorer default view" hint="The in-panel toggle overrides this for the current session.">
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setExplorerViewMode('list')}
                      className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-colors ${explorerViewMode === 'list' ? 'border-accent-blue bg-accent-blue/10' : 'border-border-soft bg-surface hover:border-border-strong'}`}>
                      <List size={14} className="text-accent-blue" />
                      <span className="text-sm text-fg">Lines</span>
                    </button>
                    <button type="button" onClick={() => setExplorerViewMode('grid')}
                      className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-colors ${explorerViewMode === 'grid' ? 'border-accent-blue bg-accent-blue/10' : 'border-border-soft bg-surface hover:border-border-strong'}`}>
                      <LayoutGrid size={14} className="text-accent-blue" />
                      <span className="text-sm text-fg">Objects</span>
                    </button>
                  </div>
                </FieldLabel>
              </div>

              <div className={sectionCls} data-setting="defaultWorkspaceType">
                <FieldLabel label="Default workspace type" hint="New projects land here until classified. Switch any project anytime from the header tabs.">
                  <div className="flex gap-2">
                    {(['dev', 'general'] as const).map((w) => (
                      <button key={w} type="button" onClick={() => setDefaultWorkspaceType(w)}
                        className={`flex-1 px-3 py-2 rounded-lg border text-sm capitalize transition-colors ${defaultWorkspaceType === w ? 'border-accent-blue bg-accent-blue/10 text-fg' : 'border-border-soft bg-surface text-fg-dim hover:border-border-strong'}`}>
                        {w === 'dev' ? 'Developer' : 'General'}
                      </button>
                    ))}
                  </div>
                </FieldLabel>
              </div>

              <div className={sectionCls} data-setting="locale">
                <FieldLabel label="Command language" hint="Phrase matching understands these languages on top of English — answers stay English.">
                  <div className="flex gap-2">
                    {(['en', 'de'] as const).map((l) => (
                      <button key={l} type="button" onClick={() => setLocale(l)}
                        className={`flex-1 px-3 py-2 rounded-lg border text-sm transition-colors ${locale === l ? 'border-accent-blue bg-accent-blue/10 text-fg' : 'border-border-soft bg-surface text-fg-dim hover:border-border-strong'}`}>
                        {l === 'en' ? 'English' : 'Deutsch'}
                      </button>
                    ))}
                  </div>
                </FieldLabel>
              </div>

              <div className={sectionCls} data-setting="generalToolsFirst">
                <div className="flex items-start gap-3">
                  <Toggle enabled={generalToolsFirst} onToggle={() => setGeneralToolsFirst(!generalToolsFirst)}
                    title={generalToolsFirst ? 'General opens the Tools grid' : 'General opens chat'} />
                  <div>
                    <p className="text-sm text-fg">General workspace opens Tools first</p>
                    <p className="text-[11px] text-fg-dim mt-0.5">When on, picking a project in General lands on the Tools card grid. When off, it lands straight on chat instead.</p>
                  </div>
                </div>
              </div>

              <div className={sectionCls} data-setting="colorFollowsMouse">
                <div className="flex items-start gap-3">
                  <Toggle enabled={colorFollowsMouse} onToggle={() => setColorFollowsMouse(!colorFollowsMouse)}
                    title={colorFollowsMouse ? 'Background glow follows the mouse' : 'Static background glow'} />
                  <div>
                    <p className="text-sm text-fg">Background glow follows the mouse</p>
                    <p className="text-[11px] text-fg-dim mt-0.5">When on, a soft accent glow tracks the pointer across the app background. Has no effect with reduced-motion on.</p>
                  </div>
                </div>
              </div>

              <div className={sectionCls} data-setting="liquidGlass">
                <div className="flex items-start gap-3">
                  <Toggle enabled={liquidGlass} onToggle={() => setLiquidGlass(!liquidGlass)}
                    title={liquidGlass ? 'Liquid glass on' : 'Plain blur'} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-fg">Liquid glass overlays</p>
                    <p className="text-[11px] text-fg-dim mt-0.5">When on, modals, palette and tour cards blur the background with an accent-color tint that follows your theme. When off, they render exactly as before.</p>
                    <div className={`mt-2 space-y-2 ${liquidGlass ? '' : 'opacity-40 pointer-events-none'}`}>
                      <label className="flex items-center gap-2 text-[11px] text-fg-dim">
                        Intensity
                        <input
                          type="range" min={0} max={100} step={1} value={glassIntensity}
                          onChange={(e) => setGlassIntensity(Number(e.target.value))}
                          className="flex-1 accent-accent-blue" title="Glass blur + tint strength"
                        />
                        <span className="w-8 text-right tabular-nums">{glassIntensity}</span>
                      </label>
                      <div className="flex items-center gap-1" role="group" aria-label="Glass reach">
                        {(['buttons', 'cards', 'all'] as const).map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setGlassScope(s)}
                            className={`px-2 py-1 rounded-md text-[10px] font-bold uppercase transition-colors ${glassScope === s ? 'bg-accent-blue/15 text-accent-blue' : 'text-fg-dim hover:text-fg-strong'}`}
                            title={s === 'buttons' ? 'Glass primary buttons only' : s === 'cards' ? 'Glass buttons, modals, palette and tour cards' : 'Glass everything above plus whole panel shells'}
                          >
                            {s === 'buttons' ? 'Buttons' : s === 'cards' ? 'Buttons + cards' : 'Everything'}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <EditorsSection />
            </>
          )}

          {/* ─── REMINDERS & NOTIFICATIONS ─────────────────────────────── */}
          {category === 'reminders' && (
            <>
              <div className="flex items-center gap-2 mb-1">
                <Bell size={18} className="text-accent-orange" />
                <h3 className="text-lg font-bold text-fg-strong">Reminders & Notifications</h3>
              </div>

              <div className={sectionCls} data-setting="persistRemindersAcrossRestart">
                <div className="flex items-start gap-3">
                  <Toggle enabled={persistRemindersAcrossRestart} onToggle={() => setPersistRemindersAcrossRestart(!persistRemindersAcrossRestart)}
                    title={persistRemindersAcrossRestart ? 'Reminders persist' : 'Reminders cleared on close'} />
                  <div>
                    <p className="text-sm text-fg">Keep reminders when I close the app</p>
                    <p className="text-[11px] text-fg-dim mt-0.5">When on, reminders survive restarts and will fire even if the app was closed. When off, all reminders are cleared on shutdown.</p>
                  </div>
                </div>
              </div>

              <div className={sectionCls} data-setting="reminderToastDurationMs">
                <FieldLabel label="Toast display duration" hint="How long reminder notifications stay on screen before auto-dismissing.">
                  <div className="flex items-center gap-3">
                    <input type="range" min={2000} max={30000} step={1000} value={reminderToastDurationMs}
                      onChange={(e) => setReminderToastDurationMs(Number(e.target.value))}
                      className="flex-1 accent-accent-blue" />
                    <span className="text-xs text-fg-strong font-mono w-12 text-right">{reminderToastDurationMs / 1000}s</span>
                  </div>
                </FieldLabel>
              </div>

              <div className={sectionCls} data-setting="reminderToastPosition">
                <FieldLabel label="Toast position" hint="Where reminder toasts appear on screen.">
                  <div className="grid grid-cols-3 gap-1.5 max-w-[200px]">
                    {(['top-left', 'top-right', 'center', 'bottom-left', 'bottom-right'] as const).map((pos) => (
                      <button key={pos} type="button" onClick={() => setReminderToastPosition(pos)}
                        className={`px-2 py-1.5 rounded-lg border text-[10px] text-center transition-colors ${
                          reminderToastPosition === pos ? 'border-accent-blue bg-accent-blue/10 text-accent-blue font-bold' : 'border-border-soft bg-surface text-fg-muted hover:border-border-strong'
                        }`}>
                        {pos.replace('-', ' ')}
                      </button>
                    ))}
                    <div />
                  </div>
                </FieldLabel>
              </div>

              <div className={sectionCls} data-setting="quietHours">
                <FieldLabel label="Quiet hours" hint="Hold desktop and webhook pushes during these local hours (history and in-app toasts continue). Overnight wraps — 22 to 7 sleeps through midnight. Off by default.">
                  <div className="flex items-center gap-2 text-xs text-fg">
                    <span className="text-fg-dim">From</span>
                    <select value={quietStart} onChange={(e) => setQuietStart(e.target.value)}
                      className="bg-surface border border-border-soft rounded-lg px-2 py-1.5 text-fg focus:outline-none focus:border-accent-blue transition-colors">
                      <option value="off">Off</option>
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                      ))}
                    </select>
                    <span className="text-fg-dim">to</span>
                    <select value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)}
                      className="bg-surface border border-border-soft rounded-lg px-2 py-1.5 text-fg focus:outline-none focus:border-accent-blue transition-colors">
                      <option value="off">Off</option>
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                      ))}
                    </select>
                  </div>
                </FieldLabel>
              </div>

              <div className={sectionCls} data-setting="aiRedirectDelayMs">
                <FieldLabel label="AI redirect delay" hint="Pause before the UI auto-opens a panel or tab after an AI trigger command. Set to 0 for instant.">
                  <div className="flex items-center gap-3">
                    <input type="range" min={0} max={10000} step={500} value={aiRedirectDelayMs}
                      onChange={(e) => setAiRedirectDelayMs(Number(e.target.value))}
                      className="flex-1 accent-accent-blue" />
                    <span className="text-xs text-fg-strong font-mono w-14 text-right">{aiRedirectDelayMs === 0 ? 'Off' : `${aiRedirectDelayMs / 1000}s`}</span>
                  </div>
                </FieldLabel>
              </div>

              <div className={sectionCls} data-setting="askBeforeDeleteLinkedNote">
                <div className="flex items-start gap-3">
                  <Toggle enabled={askBeforeDeleteLinkedNote} onToggle={() => setAskBeforeDeleteLinkedNote(!askBeforeDeleteLinkedNote)}
                    title={askBeforeDeleteLinkedNote ? 'Asks before deleting linked reminders' : 'Linked reminders deleted silently'} />
                  <div>
                    <p className="text-sm text-fg">Ask before deleting linked reminders</p>
                    <p className="text-[11px] text-fg-dim mt-0.5">When on, deleting a note that has a linked reminder asks whether to delete the reminder too. When off, linked reminders are removed automatically.</p>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ─── PRIVACY & SECURITY ────────────────────────────────────── */}
          {category === 'privacy' && (
            <>
              <div className="flex items-center gap-2 mb-1">
                <Shield size={18} className="text-accent-green" />
                <h3 className="text-lg font-bold text-fg-strong">Privacy & Security</h3>
              </div>

              <div className={sectionCls}>
                <div className="flex items-start gap-3">
                  <Toggle enabled={sandboxRiskyCommands} onToggle={() => setSandboxRiskyCommands(!sandboxRiskyCommands)}
                    title={sandboxRiskyCommands ? 'Sandboxed execution on' : 'Sandboxed execution off'} />
                  <div>
                    <p className="text-sm text-fg">Sandbox risky commands</p>
                    <p className="text-[11px] text-fg-dim mt-0.5">When on, confirmed risky commands run with an environment allowlist and a project-restricted cwd (not a container — see the docs for exact guarantees). Off by default.</p>
                  </div>
                </div>
              </div>

              <div className={sectionCls}>
                <div className="flex items-start gap-3">
                  <Toggle enabled={clipboardHistory} onToggle={() => setClipboardHistory(!clipboardHistory)}
                    title={clipboardHistory ? 'Clipboard history on' : 'Clipboard history off'} />
                  <div>
                    <p className="text-sm text-fg">Track clipboard history</p>
                    <p className="text-[11px] text-fg-dim mt-0.5">When on, the console polls the OS clipboard in the background (in-memory, most recent 25 entries, deduped). Off by default — your clipboard can hold passwords and tokens.</p>
                  </div>
                </div>
              </div>

              <div className={sectionCls}>
                <div className="flex items-start gap-3">
                  <Toggle enabled={clipboardPersist} onToggle={() => setClipboardPersist(!clipboardPersist)}
                    title={clipboardPersist ? 'Clipboard persist on' : 'Clipboard persist off'} />
                  <div>
                    <p className="text-sm text-fg">Persist clipboard history to disk</p>
                    <p className="text-[11px] text-fg-dim mt-0.5">A separate opt-in on top of tracking: writes the in-memory history to a local file so it survives restarts. Bigger privacy commitment — off by default.</p>
                  </div>
                </div>
              </div>

              <div className={sectionCls} data-setting="permissionMode" data-tour="setting-permission-mode">
                <FieldLabel label="Permission mode" hint="In Ask mode, mutating tools are declined with an explanation — no confirm prompts, no auto-runs.">
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setPermissionMode('default')}
                      className={`flex-1 px-3 py-2 rounded-lg border text-left transition-colors ${permissionMode === 'default' ? 'border-accent-blue bg-accent-blue/10' : 'border-border-soft bg-surface hover:border-border-strong'}`}>
                      <span className="block text-sm text-fg">Default</span>
                      <span className="block text-[10px] text-fg-dim mt-0.5">Normal approvals</span>
                    </button>
                    <button type="button" onClick={() => setPermissionMode('ask')}
                      className={`flex-1 px-3 py-2 rounded-lg border text-left transition-colors ${permissionMode === 'ask' ? 'border-accent-blue bg-accent-blue/10' : 'border-border-soft bg-surface hover:border-border-strong'}`}>
                      <span className="block text-sm text-fg">Ask (read-only)</span>
                      <span className="block text-[10px] text-fg-dim mt-0.5">AI can look, never touch</span>
                    </button>
                  </div>
                </FieldLabel>
              </div>
            </>
          )}

          {/* ─── ADVANCED ──────────────────────────────────────────────── */}
          {category === 'advanced' && (
            <>
              <div className="flex items-center gap-2 mb-1">
                <Sparkles size={18} className="text-accent-teal" />
                <h3 className="text-lg font-bold text-fg-strong">Advanced</h3>
              </div>

              <div className={sectionCls} data-tour="setting-scan-all">
                <div className="flex items-start gap-3">
                  <Toggle enabled={scanAllFolders} onToggle={() => setScanAllFolders(!scanAllFolders)}
                    title={scanAllFolders ? 'Every folder included' : 'Only recognized projects shown'} />
                  <div>
                    <p className="text-sm text-fg">Include every folder as a project</p>
                    <p className="text-[11px] text-fg-dim mt-0.5">When on, every immediate subfolder appears in the project list, even folders with no code, git, or config. Off by default — junk folders stay hidden. Rescan to apply.</p>
                  </div>
                </div>
              </div>

              <TuningSection />
            </>
          )}

          {/* ─── HELP & TOURS ──────────────────────────────────────────── */}
          {category === 'help' && (
            <>
              <div className="flex items-center gap-2 mb-1">
                <HelpCircle size={18} className="text-accent-teal" />
                <h3 className="text-lg font-bold text-fg-strong">Help & Tours</h3>
              </div>
              <p className="text-[11px] text-fg-dim mb-3">Replay any guided walkthrough, any time.</p>

              <div className={sectionCls}>
                {(() => {
                  const groups = TOUR_GROUPS.length
                    ? TOUR_GROUPS.map((g) => ({
                        label: g.label,
                        sections: g.sectionIds.map((id) => TOUR_SECTIONS.find((s) => s.id === id)).filter(Boolean) as import('../tours').TourSection[],
                      }))
                    : [{ label: 'All tours', sections: TOUR_SECTIONS }];
                  return (
                    <div className="space-y-3">
                      {groups.map((grp) => (
                        <div key={grp.label}>
                          <p className="text-[11px] font-bold tracking-wider uppercase text-fg-dim mb-1">{grp.label}</p>
                          <div className="grid grid-cols-2 gap-1.5">
                            {grp.sections.map((s) => (
                              <button key={s.id} type="button" onClick={() => launchTour(s.id)}
                                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border-soft text-[11px] text-fg-subtle hover:border-accent-teal/50 hover:text-fg-strong transition-colors text-left"
                                title={s.description}>
                                <Compass size={11} className="text-accent-teal flex-shrink-0" />
                                <span className="truncate">{s.label}</span>
                                {toursTaken[s.id] && <span className="ml-auto text-[9px] text-accent-green flex-shrink-0">done</span>}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </>
          )}

          {/* ─── USERS (portal) ──────────────────────────────────────────── */}
          {category === 'users' && showUsers && (
            <>
              <div className="flex items-center gap-2 mb-1">
                <Users size={18} className="text-accent-blue" />
                <h3 className="text-lg font-bold text-fg-strong">Users</h3>
              </div>
              <p className="text-[11px] text-fg-dim mb-3">
                {authArmed
                  ? 'Accounts on this server — chats and profiles are per-user.'
                  : 'No accounts yet — create the first admin to require login.'}
              </p>
              <div className={sectionCls}>
                <UsersSection authArmed={authArmed} authRole={authRole} />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 px-6 pb-6 pt-2 border-t border-border-faint">
        <button type="button" onClick={() => onSave({ setupComplete: false })}
          className="mr-auto px-3 py-2 text-[10px] text-fg-dim hover:text-fg-strong transition-colors border border-border-faint rounded-lg"
          title="Resets setupComplete so the first-run wizard appears again on the next load">
          Reset onboarding
        </button>
        <button onClick={onClose} className="px-4 py-2 text-xs text-fg-subtle hover:text-fg-strong transition-colors">Cancel</button>
        <button onClick={handleSave}
          className="px-4 py-2 bg-accent-blue text-white rounded-lg text-xs font-bold tracking-wider uppercase hover:opacity-90 transition-opacity">
          Save
        </button>
      </div>
    </ModalShell>
  );
}

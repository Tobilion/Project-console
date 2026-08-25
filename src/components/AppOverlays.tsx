// All fixed-position overlays (2026-08-24, split out of App.tsx): the confirm-card overlay,
// Ctrl+K command deck, chat-history modal, profile modal, first-run wizard, tour picker +
// overlay, shortcuts help and the toast stack. Pure props — App owns every piece of state.

import { CommandDeck } from './CommandDeck';
import { ChatHistoryOverlay } from './ChatHistoryOverlay';
import { UserProfileModal } from './UserProfileModal';
import { FirstRunSetup } from './FirstRunSetup';
import { TourOverlay, TourPicker } from './TourOverlay';
import { ShortcutsOverlay } from './ui/ShortcutsOverlay';
import { Toaster } from './ui/Toast';
import { ConfirmCardsOverlay } from './ConfirmCardsOverlay';
import { getTourSection } from '../tours';
import type { TourSection } from '../tours';
import type { UserProfile } from '../hooks/useUserProfile';

export interface AppOverlaysProps {
  chatViewActive: boolean;
  pendingConfirm: unknown;
  handleConfirm: (v: boolean) => void;
  pendingToolConfirm: unknown;
  handleToolConfirm: (v: boolean) => void;
  handleApproveTask: () => void;
  pendingMemorySuggestion: unknown;
  handleMemorySuggestionRespond: (v: boolean) => void;
  deckOpen: boolean;
  setDeckOpen: (v: boolean) => void;
  deck: Omit<React.ComponentProps<typeof CommandDeck>, 'open' | 'onClose'>;
  chatHistoryOpen: boolean;
  setChatHistoryOpen: (v: boolean) => void;
  history: Omit<React.ComponentProps<typeof ChatHistoryOverlay>, 'open' | 'onClose'>;
  profileOpen: boolean;
  setProfileOpen: (v: boolean) => void;
  profile: UserProfile;
  updateProfile: (p: Partial<UserProfile>) => void;
  firstRun: React.ComponentProps<typeof FirstRunSetup>;
  tourPickerOpen: boolean;
  setTourPickerOpen: (v: boolean) => void;
  tourSection: TourSection | null;
  setTourSection: (v: TourSection | null) => void;
  tourMode: 'card' | 'guided';
  setTourMode: (v: 'card' | 'guided') => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;
}

export function AppOverlays(props: AppOverlaysProps) {
  const {
    chatViewActive, pendingConfirm, handleConfirm, pendingToolConfirm, handleToolConfirm,
    handleApproveTask, pendingMemorySuggestion, handleMemorySuggestionRespond,
    deckOpen, setDeckOpen, deck, chatHistoryOpen, setChatHistoryOpen, history,
    profileOpen, setProfileOpen, profile, updateProfile, firstRun,
    tourPickerOpen, setTourPickerOpen, tourSection, setTourSection, tourMode, setTourMode,
    shortcutsOpen, setShortcutsOpen,
  } = props;

  return (
    <>
      {/* 2026-08-12 audit fix: confirm cards render as a fixed overlay so they are visible
          regardless of which top-level view is active (chat, Tools panels, dashboard) — a
          confirm-gated action triggered from a panel must never strand the user. When the
          chat itself IS the active view, the cards render inline in the thread instead
          (TerminalMessages) — the overlay only covers the views where that thread is
          unmounted. */}
      {!chatViewActive && (
        <ConfirmCardsOverlay
          pendingConfirm={pendingConfirm as never}
          onConfirm={handleConfirm}
          pendingToolConfirm={pendingToolConfirm as never}
          onToolConfirm={handleToolConfirm}
          onApproveTask={handleApproveTask}
          pendingMemorySuggestion={pendingMemorySuggestion as never}
          onMemorySuggestionRespond={handleMemorySuggestionRespond}
        />
      )}

      <CommandDeck open={deckOpen} onClose={() => setDeckOpen(false)} {...deck} />

      <ChatHistoryOverlay
        open={chatHistoryOpen}
        onClose={() => setChatHistoryOpen(false)}
        {...history}
      />

      <UserProfileModal
        open={profileOpen}
        profile={profile}
        onClose={() => setProfileOpen(false)}
        onSave={updateProfile}
      />

      <FirstRunSetup {...firstRun} />

      {/* Phase T2: tour system — the section picker (Welcome "Take the Tour") and the
          active overlay. Guided steps switch the main view via the lpc:tour-view listener. */}
      {tourPickerOpen && (
        <TourPicker
          onClose={() => setTourPickerOpen(false)}
          onPick={(sectionId, mode) => {
            const section = getTourSection(sectionId);
            if (!section) return;
            setTourPickerOpen(false);
            setTourSection(section);
            setTourMode(mode);
          }}
        />
      )}
      {tourSection && (
        <TourOverlay
          section={tourSection}
          mode={tourMode}
          onClose={() => setTourSection(null)}
        />
      )}

      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <Toaster />
    </>
  );
}
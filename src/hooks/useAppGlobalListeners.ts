// Global keyboard + CustomEvent listeners (2026-08-24, split out of App.tsx): the Ctrl+K
// deck toggle, the "?" shortcuts overlay (outside text inputs), and the guided-tour
// view/launch events. Pure listeners — they only flip view state.

import { useEffect } from 'react';
import type { TourSection } from '../tours';
import { getTourSection } from '../tours';

export interface UseAppGlobalListenersDeps {
  setDeckOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setShortcutsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setShowDashboard: React.Dispatch<React.SetStateAction<boolean>>;
  setShowCommandRef: React.Dispatch<React.SetStateAction<boolean>>;
  setToolsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setTourPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setTourSection: React.Dispatch<React.SetStateAction<TourSection | null>>;
}

export function useAppGlobalListeners(deps: UseAppGlobalListenersDeps) {
  const { setDeckOpen, setShortcutsOpen, setShowDashboard, setShowCommandRef, setToolsOpen, setTourPickerOpen, setTourSection } = deps;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setDeckOpen(v => !v);
        return;
      }
      // "?" opens the shortcuts overlay — only outside text inputs (typing "?" in chat is a
      // legitimate character).
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        setShortcutsOpen(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setDeckOpen, setShortcutsOpen]);

  // Phase T2: guided-tour plumbing. 'lpc:tour-view' switches the main view so a guided
  // step can point at the Tools grid / dashboard / chat; 'lpc:launch-tour' starts a section
  // (dispatched by the settings modal's Tours section).
  useEffect(() => {
    const onTourView = (e: Event) => {
      const view = (e as CustomEvent).detail?.view;
      if (view === 'tools') { setShowDashboard(false); setShowCommandRef(false); setToolsOpen(true); }
      else if (view === 'dashboard') { setShowDashboard(true); setShowCommandRef(false); setToolsOpen(false); }
      else if (view === 'general') { setShowDashboard(false); setToolsOpen(false); setShowCommandRef(false); }
      else { setShowDashboard(false); setToolsOpen(false); setShowCommandRef(false); }
    };
    const onLaunchTour = (e: Event) => {
      const sectionId = (e as CustomEvent).detail?.section;
      const section = sectionId ? getTourSection(sectionId) : null;
      if (section) { setTourPickerOpen(false); setTourSection(section); }
    };
    window.addEventListener('lpc:tour-view', onTourView);
    window.addEventListener('lpc:launch-tour', onLaunchTour);
    return () => {
      window.removeEventListener('lpc:tour-view', onTourView);
      window.removeEventListener('lpc:launch-tour', onLaunchTour);
    };
  }, [setShowDashboard, setShowCommandRef, setToolsOpen, setTourPickerOpen, setTourSection]);
}
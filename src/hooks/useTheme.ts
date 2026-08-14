import { useEffect, useState } from 'react';

const STORAGE_KEY = 'theme';

export type Theme = 'dark' | 'light';

function readInitial(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {}
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Module-level shared store (2026-08-13): more than one component owns a theme toggle now
// (the header ThemeToggle and the Ctrl+K deck), and two independent useState instances would
// drift apart visually — toggling from the deck would leave the header's icon stale. A tiny
// pub/sub keeps every instance in sync with the same API and no context provider.
let sharedTheme: Theme = readInitial();
const listeners = new Set<(t: Theme) => void>();

function applyTheme(t: Theme) {
  sharedTheme = t;
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {}
  listeners.forEach((l) => l(t));
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(sharedTheme);

  useEffect(() => {
    listeners.add(setTheme);
    return () => {
      listeners.delete(setTheme);
    };
  }, []);

  const toggleTheme = () => applyTheme(sharedTheme === 'dark' ? 'light' : 'dark');

  return { theme, toggleTheme };
}

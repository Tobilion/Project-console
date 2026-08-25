// ChatWorkspace props (2026-08-24, split out of App.tsx's Terminal/Sidebar wiring): three
// sub-prop bags matching the components' own prop interfaces, so a prop-type change in a
// child can never drift here.

import type { ComponentProps } from 'react';
import type { Terminal } from './Terminal';
import type { SidebarDrawer } from './SidebarDrawer';
import type { WelcomeScreen } from './WelcomeScreen';

export interface ChatWorkspaceProps {
  chatFullscreen: boolean;
  onToggleFullscreen: () => void;
  showWelcome: boolean;
  onOpenChatHistory: () => void;
  onOpenTourPicker: () => void;
  sidebar: Omit<ComponentProps<typeof SidebarDrawer>, 'onOpenChatHistory'>;
  welcome: Omit<ComponentProps<typeof WelcomeScreen>, 'onOpenTourPicker'>;
  terminal: Omit<ComponentProps<typeof Terminal>, 'isFullscreen' | 'onToggleFullscreen' | 'onOpenChatHistory'>;
}
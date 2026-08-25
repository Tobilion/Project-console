// The chat workspace (2026-08-24, split out of App.tsx): the sidebar + terminal row and the
// Welcome-screen/chat switch. Pure props — App owns all state; this is the layout. The three
// child prop bags (sidebar/welcome/terminal) pass through verbatim.

import { SidebarDrawer } from './SidebarDrawer';
import { Terminal } from './Terminal';
import { WelcomeScreen } from './WelcomeScreen';
import type { ChatWorkspaceProps } from './ChatWorkspaceProps';

export function ChatWorkspace(props: ChatWorkspaceProps) {
  const { chatFullscreen, onToggleFullscreen, showWelcome, onOpenChatHistory, onOpenTourPicker, sidebar, welcome, terminal } = props;

  return (
    <div className={chatFullscreen ? 'flex-1 min-h-0' : 'flex-1 min-h-0 flex flex-col lg:flex-row gap-6'}>
      {!chatFullscreen && <SidebarDrawer {...sidebar} onOpenChatHistory={onOpenChatHistory} />}

      <div className={chatFullscreen ? 'h-full w-full' : 'flex-1 min-h-0 min-w-0'}>
        <div className={`h-full w-full ${chatFullscreen ? '' : 'max-w-4xl mx-auto'}`}>
          {showWelcome && !chatFullscreen ? (
            <WelcomeScreen {...welcome} onOpenTourPicker={onOpenTourPicker} />
          ) : (
            <Terminal {...terminal} isFullscreen={chatFullscreen} onToggleFullscreen={onToggleFullscreen} onOpenChatHistory={onOpenChatHistory} />
          )}
        </div>
      </div>
    </div>
  );
}
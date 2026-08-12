import React from 'react';

interface TerminalEmptyStateProps {
  greeting: string;
  actions: string[];
  onAction: (msg: string) => void;
}

/** Centered greeting shown in the chat thread while it has no messages yet — replaced by the
 *  real thread the moment the first message arrives. Pure display + quick-action chips; the
 *  chips are ordinary chat messages, so all existing confirm gates still apply. */
export function TerminalEmptyState({ greeting, actions, onAction }: TerminalEmptyStateProps) {
  return (
    <div className="text-center select-none">
      <h2 className="text-2xl font-semibold text-fg-strong">{greeting}</h2>
      {actions.length > 0 && (
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {actions.map((action) => (
            <button
              key={action}
              onClick={() => onAction(action)}
              className="px-3 py-1.5 rounded-full bg-panel hover:bg-panel-strong border border-border-faint hover:border-accent-blue text-xs text-accent-teal transition-colors"
            >
              {action}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

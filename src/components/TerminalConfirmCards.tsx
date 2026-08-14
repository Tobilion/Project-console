import React from 'react';
import { PendingToolConfirm, PendingMemorySuggestion } from '../types';
import { motion } from 'motion/react';
import { Search, Brain, CheckCircle, XCircle } from 'lucide-react';

interface TerminalConfirmCardsProps {
  pendingConfirm: { token: string; command: string } | null;
  onConfirm: (confirmed: boolean) => void;
  pendingToolConfirm: PendingToolConfirm | null;
  onToolConfirm: (confirmed: boolean) => void;
  onApproveTask?: () => void;
  pendingMemorySuggestion?: PendingMemorySuggestion | null;
  onMemorySuggestionRespond?: (accept: boolean) => void;
}

/** Inline confirm chips rendered inside the message thread: risky command approval,
 *  AI tool approval (with the optional session-grant button), and memory suggestions. */
export function TerminalConfirmCards({
  pendingConfirm,
  onConfirm,
  pendingToolConfirm,
  onToolConfirm,
  onApproveTask,
  pendingMemorySuggestion,
  onMemorySuggestionRespond,
}: TerminalConfirmCardsProps) {
  return (
    <>
      {pendingConfirm && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-start"
        >
          <div className="bg-accent-orange/10 border border-accent-orange/20 text-accent-orange rounded-xl px-4 py-3 max-w-[85%]">
            <div className="flex items-center gap-2 text-accent-orange">
              <Search size={13} />
              <span className="font-bold text-[10px] tracking-wider uppercase">Safety Confirmation</span>
            </div>
            <p className="font-mono text-xs mt-2">
              Execute: <span className="text-fg-strong bg-scrim px-1.5 py-0.5 rounded border border-border-soft break-all">{pendingConfirm.command}</span>
            </p>
            <div className="flex flex-wrap gap-2 mt-3">
              <button
                onClick={() => onConfirm(true)}
                className="flex items-center gap-1.5 px-3.5 py-2 bg-accent-red/20 hover:bg-accent-red/40 text-accent-red rounded-lg border border-accent-red/30 transition-colors text-xs font-bold"
              >
                <CheckCircle size={13} /> Execute
              </button>
              <button
                onClick={() => onConfirm(false)}
                className="flex items-center gap-1.5 px-3.5 py-2 bg-panel hover:bg-panel-strong text-fg-muted rounded-lg border border-border-soft transition-colors text-xs"
              >
                <XCircle size={13} /> Cancel
              </button>
            </div>
          </div>
        </motion.div>
      )}

      {pendingToolConfirm && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-start"
        >
          <div className="bg-accent-orange/10 border border-accent-orange/20 text-accent-orange rounded-xl px-4 py-3 max-w-[85%]">
            <div className="flex items-center gap-2 text-accent-orange">
              <Brain size={13} />
              <span className="font-bold text-[10px] tracking-wider uppercase">AI wants to run: {pendingToolConfirm.tool}</span>
            </div>
            <pre className="font-mono text-xs mt-2 mb-3 whitespace-pre-wrap break-all bg-scrim px-2 py-1.5 rounded border border-border-soft text-fg-muted max-h-32 overflow-y-auto">
              {JSON.stringify(pendingToolConfirm.args, null, 2)}
            </pre>
            {pendingToolConfirm.preview && (
              <div className="mt-2 mb-3">
                <div className="text-[10px] tracking-wider uppercase text-fg-dim font-mono mb-1">
                  {pendingToolConfirm.preview.mode === 'create' ? 'Will create' : 'Preview'}{' '}
                  <span className="break-all">{pendingToolConfirm.preview.path}</span>
                </div>
                <pre className="font-mono text-xs whitespace-pre-wrap break-all bg-scrim px-2 py-1.5 rounded border border-border-soft max-h-40 overflow-y-auto">
                  {pendingToolConfirm.preview.removed.map((l) => (
                    <span key={`r${l}`} className="block text-accent-red">- {l}</span>
                  ))}
                  {pendingToolConfirm.preview.removedMore > 0 && (
                    <span className="block text-fg-dim">… {pendingToolConfirm.preview.removedMore} more removed</span>
                  )}
                  {pendingToolConfirm.preview.added.map((l) => (
                    <span key={`a${l}`} className="block text-accent-green">+ {l}</span>
                  ))}
                  {pendingToolConfirm.preview.addedMore > 0 && (
                    <span className="block text-fg-dim">… {pendingToolConfirm.preview.addedMore} more added</span>
                  )}
                </pre>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => onToolConfirm(true)}
                className="flex items-center gap-1.5 px-3.5 py-2 bg-accent-red/20 hover:bg-accent-red/40 text-accent-red rounded-lg border border-accent-red/30 transition-colors text-xs font-bold"
              >
                <CheckCircle size={13} /> Approve
              </button>
              <button
                onClick={() => onToolConfirm(false)}
                className="flex items-center gap-1.5 px-3.5 py-2 bg-panel hover:bg-panel-strong text-fg-muted rounded-lg border border-border-soft transition-colors text-xs"
              >
                <XCircle size={13} /> Reject
              </button>
            </div>
            {onApproveTask && pendingToolConfirm.tool !== 'executeCommand' && (
              <button
                onClick={onApproveTask}
                className="mt-2 flex items-center gap-1.5 px-3.5 py-2 bg-accent-green/20 hover:bg-accent-green/40 text-accent-green rounded-lg border border-accent-green/30 transition-colors text-xs"
                title="Approves this edit AND lets the rest of this task's file edits run without asking. Commands and tests still confirm every time."
              >
                <CheckCircle size={13} /> Approve + auto-approve file edits this conversation
              </button>
            )}
          </div>
        </motion.div>
      )}

      {pendingMemorySuggestion && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-start"
        >
          <div className="bg-accent-teal/10 border border-accent-teal/20 text-accent-teal rounded-xl px-4 py-3 max-w-[85%]">
            <div className="flex items-center gap-2 text-accent-teal">
              <Brain size={13} />
              <span className="font-bold text-[10px] tracking-wider uppercase">Memory suggestion</span>
            </div>
            <p className="text-xs mt-2">{pendingMemorySuggestion.message}</p>
            <div className="flex flex-wrap gap-2 mt-3">
              <button
                onClick={() => onMemorySuggestionRespond?.(true)}
                className="flex items-center gap-1.5 px-3.5 py-2 bg-accent-teal/20 hover:bg-accent-teal/40 text-accent-teal rounded-lg border border-accent-teal/30 transition-colors text-xs font-bold"
              >
                <CheckCircle size={13} /> Add to CLAUDE.md
              </button>
              <button
                onClick={() => onMemorySuggestionRespond?.(false)}
                className="flex items-center gap-1.5 px-3.5 py-2 bg-panel hover:bg-panel-strong text-fg-muted rounded-lg border border-border-soft transition-colors text-xs"
              >
                <XCircle size={13} /> Not now
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </>
  );
}

import React from 'react';
import { FileDown } from 'lucide-react';
import { CopyButton } from './ui/CopyButton';

/** Parses a JSON code-block child string and returns the parsed object, or null. */
function tryParseJsonBlock(children: React.ReactNode): Record<string, unknown> | null {
  const text = typeof children === 'string' ? children : '';
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return null;
}

/** Renders a ```json block with copy button and type-specific actions when in structured mode. */
export function StructuredJsonBlock({ content, onSendMessage }: { content: string; onSendMessage: (msg: string) => void }) {
  const parsed = tryParseJsonBlock(content);
  const dataType = parsed?.type as string || 'generic';
  const handleApply = () => {
    const path = parsed?.data && typeof parsed.data === 'object' ? (parsed.data as any).path || null : null;
    if (path) {
      onSendMessage(`Write the following to ${path}:\n\`\`\`\n${JSON.stringify(parsed.data, null, 2)}\n\`\`\``);
    } else {
      onSendMessage(`Apply this to the project:\n\`\`\`json\n${content}\n\`\`\``);
    }
  };

  return (
    <div className="relative group">
      <div className="flex items-center justify-between px-3 py-1.5 bg-scrim-faint border-b border-border-soft rounded-t-lg">
        <span className="text-[10px] font-mono text-fg-dim uppercase tracking-wider">
          JSON {dataType !== 'generic' ? `— ${dataType.replace('_', ' ')}` : ''}
        </span>
        <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
           <CopyButton text={content} title="Copy JSON" size={12} className="p-1 text-fg-dim hover:text-fg-strong transition-colors" />
          {parsed && (
            <button onClick={handleApply} className="p-1 text-fg-dim hover:text-accent-teal transition-colors" title={parsed?.data && typeof parsed.data === 'object' && (parsed.data as any).path ? `Apply to ${(parsed.data as any).path}` : 'Apply to project'}>
              <FileDown size={12} />
            </button>
          )}
        </div>
      </div>
      <pre className="bg-scrim border border-border-soft rounded-b-lg p-3 overflow-x-auto">
        <code className="text-xs text-fg">{content}</code>
      </pre>
    </div>
  );
}

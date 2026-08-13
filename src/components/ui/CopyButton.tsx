import React, { useState } from 'react';
import { Copy } from 'lucide-react';

interface CopyButtonProps {
  text: string;
  title?: string;
  size?: number;
  label?: string;
  className?: string;
  feedback?: boolean;
}

/** A self-contained copy-to-clipboard button. `feedback` toggles the temporary "Copied" label —
 *  when false (ProcessDock/ToolHistory buttons), it stays a static icon+label, matching the
 *  original behavior at those call sites. */
export function CopyButton({ text, title, size = 12, label, className = '', feedback = true }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={handleCopy}
      className={className}
      title={title}
    >
      {feedback && copied ? (
        <span className="text-[10px] text-accent-teal">Copied</span>
      ) : label ? (
        <>
          <Copy size={size} /> {label}
        </>
      ) : (
        <Copy size={size} />
      )}
    </button>
  );
}

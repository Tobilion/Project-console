import React, { useState, useEffect, useRef } from 'react';

const CHARS = '!<>-_\\\\/[]{}—=+*^?#________';

export const TextScramble = ({ text, className = '' }: { text: string, className?: string }) => {
  // displayText is a ReactNode array (not a markup string): scramble spans and literal chars
  // are React children, so they're escaped. The previous dangerouslySetInnerHTML built a string
  // from CHARS (which contains <>) — a profile name with markup could inject into the DOM
  // (audit 2026-08-06, Phase 3: self-XSS via the header scramble).
  const [displayText, setDisplayText] = useState<React.ReactNode[]>(() => text.split(''));
  const frameRef = useRef(0);
  const queueRef = useRef<{from: string, to: string, start: number, end: number, char?: string}[]>([]);

  useEffect(() => {
    let frame = 0;
    const length = Math.max(text.length, displayText.length);
    const queue = [];
    for (let i = 0; i < length; i++) {
      const from = displayText[i] || '';
      const to = text[i] || '';
      const start = Math.floor(Math.random() * 40);
      const end = start + Math.floor(Math.random() * 40);
      queue.push({ from, to, start, end });
    }
    queueRef.current = queue;

    const update = () => {
      let nodes: React.ReactNode[] = [];
      let complete = 0;
      for (let i = 0, n = queueRef.current.length; i < n; i++) {
        let { from, to, start, end, char } = queueRef.current[i];
        if (frame >= end) {
          complete++;
          nodes.push(to);
        } else if (frame >= start) {
          if (!char || Math.random() < 0.28) {
            char = CHARS[Math.floor(Math.random() * CHARS.length)];
            queueRef.current[i].char = char;
          }
          // className (not class) + JSX so char is escaped — part of the same self-XSS fix.
          nodes.push(<span key={i} className="text-fg-strong/30">{char}</span>);
        } else {
          nodes.push(from);
        }
      }
      setDisplayText(nodes);
      if (complete === queueRef.current.length) {
        setDisplayText(text.split(''));
      } else {
        frame++;
        frameRef.current = requestAnimationFrame(update);
      }
    };
    
    update();
    return () => cancelAnimationFrame(frameRef.current);
  }, [text]);

  return (
    <span className={className}>
      {displayText.map((node, i) => <React.Fragment key={i}>{node}</React.Fragment>)}
    </span>
  );
};

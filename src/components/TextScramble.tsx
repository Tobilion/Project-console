import React, { useState, useEffect, useRef } from 'react';

const CHARS = '!<>-_\\\\/[]{}—=+*^?#________';

export const TextScramble = ({ text, className = '' }: { text: string, className?: string }) => {
  const [displayText, setDisplayText] = useState(text);
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
      let output = '';
      let complete = 0;
      for (let i = 0, n = queueRef.current.length; i < n; i++) {
        let { from, to, start, end, char } = queueRef.current[i];
        if (frame >= end) {
          complete++;
          output += to;
        } else if (frame >= start) {
          if (!char || Math.random() < 0.28) {
            char = CHARS[Math.floor(Math.random() * CHARS.length)];
            queueRef.current[i].char = char;
          }
          output += `<span class="text-fg-strong/30">${char}</span>`;
        } else {
          output += from;
        }
      }
      setDisplayText(output);
      if (complete === queueRef.current.length) {
        setDisplayText(text);
      } else {
        frame++;
        frameRef.current = requestAnimationFrame(update);
      }
    };
    
    update();
    return () => cancelAnimationFrame(frameRef.current);
  }, [text]);

  return <span className={className} dangerouslySetInnerHTML={{ __html: displayText }} />;
};

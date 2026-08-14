import React, { useRef, useState } from 'react';

interface SpotlightCardProps {
  children: React.ReactNode;
  className?: string;
  active?: boolean;
  onClick?: () => void;
}

export const SpotlightCard = ({ children, className = '', active, onClick }: SpotlightCardProps) => {
  const divRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [opacity, setOpacity] = useState(0);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!divRef.current) return;
    const div = divRef.current;
    const rect = div.getBoundingClientRect();
    setPosition({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  return (
    <div
      ref={divRef}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setOpacity(1)}
      onMouseLeave={() => setOpacity(0)}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
      } : undefined}
      className={`relative rounded-xl border overflow-hidden transition-all duration-200 cursor-pointer ${
        active
          ? 'border-accent-blue/60 bg-accent-blue/10'
          : 'border-border-faint bg-panel hover:border-accent-blue/50'
      } ${className}`}
    >
      <div
        className="pointer-events-none absolute -inset-px opacity-0 transition duration-300"
        style={{
          opacity,
          // accent-teal as a token (the old literal rgba(100,210,255,.1) was the same color
          // hardcoded) — color-mix keeps the 10% tint theme-aware.
          background: `radial-gradient(600px circle at ${position.x}px ${position.y}px, color-mix(in srgb, var(--color-accent-teal) 10%, transparent), transparent 40%)`,
        }}
      />
      {children}
    </div>
  );
};

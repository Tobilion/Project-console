import { Moon, Sun } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useTheme } from '../../hooks/useTheme';

interface ThemeToggleProps {
  className?: string;
}

export const ThemeToggle = ({ className }: ThemeToggleProps) => {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <div
      className={cn(
        'flex w-16 h-11 p-1 items-center rounded-full cursor-pointer transition-colors duration-300 flex-shrink-0',
        isDark ? 'bg-surface border border-border' : 'bg-panel border border-border',
        className
      )}
      onClick={toggleTheme}
      role="button"
      tabIndex={0}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleTheme();
        }
      }}
    >
      <div className="flex justify-between items-center w-full relative">
        <div
          className={cn(
            'flex justify-center items-center w-6 h-6 rounded-full transition-transform duration-300 z-10',
            isDark ? 'transform translate-x-0 bg-surface' : 'transform translate-x-8 bg-white shadow-sm'
          )}
        >
          {isDark ? (
            <Moon size={14} className="text-foreground" strokeWidth={1.5} />
          ) : (
            // Icon-convention exception (Stage G, documented): the sun stays yellow — the
            // universal "sun" glyph convention; mapping it to accent-orange would read as
            // a warning color. Deliberate exception, not a missed sweep.
            <Sun size={14} className="text-yellow-500" strokeWidth={1.5} />
          )}
        </div>
        <div
          className={cn(
            'flex justify-center items-center w-6 h-6 rounded-full transition-opacity duration-300 absolute right-0',
            isDark ? 'opacity-100' : 'opacity-0'
          )}
        >
          <Sun size={14} className="text-muted-foreground" strokeWidth={1.5} />
        </div>
        <div
          className={cn(
            'flex justify-center items-center w-6 h-6 rounded-full transition-opacity duration-300 absolute left-0',
            isDark ? 'opacity-0' : 'opacity-100'
          )}
        >
          <Moon size={14} className="text-muted-foreground" strokeWidth={1.5} />
        </div>
      </div>
    </div>
  );
};
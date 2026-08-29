import { Github, Globe } from 'lucide-react';

export function AppFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="relative z-10 flex-shrink-0 border-t border-border-faint bg-overlay/80 backdrop-blur supports-[backdrop-filter]:bg-overlay/60">
      <div className="mx-auto max-w-6xl px-6 py-3 flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] leading-none">
        <p className="flex items-center gap-1.5 text-fg-dim">
          <span className="text-fg-subtle font-medium">Made by Tobiloba Jagun</span>
          <span className="text-fg-faint">•</span>
          <span className="hidden sm:inline text-fg-faint">© {year}</span>
        </p>
        <div className="flex items-center gap-3">
          <a
            href="https://github.com/Tobilion"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-fg-dim hover:text-fg-strong transition-colors"
            aria-label="GitHub — Tobilion"
            title="GitHub — github.com/Tobilion"
          >
            <Github size={13} />
            <span className="font-medium">GitHub</span>
          </a>
          <span className="w-px h-3 bg-border-soft" aria-hidden />
          <a
            href="https://github.com/Tobilion/Project-console"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-fg-dim hover:text-accent-blue transition-colors"
            aria-label="Project Console on GitHub"
            title="Project Console — github.com/Tobilion/Project-console"
          >
            <span className="font-medium">Project Console</span>
          </a>
          <span className="w-px h-3 bg-border-soft hidden sm:block" aria-hidden />
          <a
            href="https://tobiloba-jagun-portfolio.vercel.app"
            target="_blank"
            rel="noreferrer"
            className="hidden sm:inline-flex items-center gap-1.5 text-fg-dim hover:text-fg-strong transition-colors"
            aria-label="Portfolio"
            title="Portfolio — tobiloba-jagun-portfolio.vercel.app"
          >
            <Globe size={13} />
            <span className="font-medium">Portfolio</span>
          </a>
        </div>
      </div>
    </footer>
  );
}

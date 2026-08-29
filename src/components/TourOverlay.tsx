import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Check, ChevronLeft, ChevronRight, X, Sparkles } from 'lucide-react';
import { cn } from '../lib/utils';
import { TourSection, TourStep, markTourTaken, TOUR_SECTIONS, TOUR_GROUPS, readToursTaken } from '../tours';

// Phase T2 (2026-08-14): the tour overlay — two modes per section:
//  - 'card': the classic modal-card steps (works from any view, zero app coupling);
//  - 'guided': card steps that ALSO drive the app — each step with `view` (+ optional
//    `panel` for Tools) triggers a custom 'lpc:tour-view' event (App.tsx switches the
//    main view: tools/dashboard/chat and opens the panel) and each step with `target`
//    spotlights the real element (a `data-tour` attribute; the overlay scrolls it into
//    view and draws a ring around it). Steps without a target render as plain cards
//    inside the guided tour.
interface TourOverlayProps {
  section: TourSection;
  mode: 'card' | 'guided';
  onClose: () => void;
}

export function TourOverlay({ section, mode, onClose }: TourOverlayProps) {
  const [step, setStep] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

  const current: TourStep = section.steps[step];
  const total = section.steps.length;

  // Guided mode: on each step change, switch the app view (if the step wants one, incl.
  // an optional Tools panel) and locate the target element for the spotlight ring.
  // Lazy panels need a RAF + delay before they are in the DOM, so query twice.
  useEffect(() => {
    if (mode !== 'guided') return;
    if (current.view) {
      const detail: Record<string, string> = { view: current.view };
      if (current.panel) detail.panel = current.panel;
      window.dispatchEvent(new CustomEvent('lpc:tour-view', { detail }));
    }
    if (current.target) {
      let cancelled = false;
      const locate = () => {
        if (cancelled) return;
        const el = document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`);
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          const t = window.setTimeout(() => {
            if (!cancelled) setTargetRect(el.getBoundingClientRect());
          }, 420);
          // Store timeout on closure for cleanup (captured via let)
          (locate as unknown as { _t?: number })._t = t as unknown as number;
        } else {
          // Panel lazy chunk not yet mounted — retry shortly
          const t2 = window.setTimeout(locate, 180);
          (locate as unknown as { _t?: number })._t = t2 as unknown as number;
        }
      };
      // First RAF ensures the view flip has committed
      const raf = requestAnimationFrame(() => locate());
      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
        const t = (locate as unknown as { _t?: number })._t;
        if (t) clearTimeout(t as unknown as number);
        setTargetRect(null);
      };
    }
    setTargetRect(null);
  }, [step, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-measure on resize and on scroll so the ring tracks the element inside
  // scrollable panels (Tools grid, panel scroll containers, dashboard).
  useEffect(() => {
    if (mode !== 'guided' || !current.target || !targetRect) return;
    const onRecalc = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`);
      if (el) setTargetRect(el.getBoundingClientRect());
    };
    window.addEventListener('resize', onRecalc);
    window.addEventListener('scroll', onRecalc, true);
    return () => {
      window.removeEventListener('resize', onRecalc);
      window.removeEventListener('scroll', onRecalc, true);
    };
  }, [mode, current.target, targetRect]);

  // Escape closes — the same keyboard path every modal in the app offers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setStep((s) => Math.min(s + 1, total - 1));
      if (e.key === 'ArrowLeft') setStep((s) => Math.max(s - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, total]);

  const finish = () => {
    markTourTaken(section.id);
    onClose();
  };

  const icon = typeof current.icon === 'string' ? (
    <span className="text-accent-teal text-2xl leading-none">{current.icon}</span>
  ) : current.icon;

  return (
    <>
      {/* Spotlight ring around the guided step's target element. */}
      {mode === 'guided' && targetRect && (
        <div
          className="fixed z-[60] pointer-events-none rounded-xl border-2 border-accent-teal shadow-[0_0_0_4px_rgba(100,210,255,0.25)] transition-all duration-200"
          style={{
            left: targetRect.left - 4,
            top: targetRect.top - 4,
            width: targetRect.width + 8,
            height: targetRect.height + 8,
          }}
        />
      )}

      <motion.div
        className="fixed inset-0 z-50 flex items-center justify-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
      >
        {mode === 'guided' ? (
          <div className="absolute inset-0 bg-scrim-strong/60 backdrop-blur-[2px]" onClick={onClose} />
        ) : (
          <div className="absolute inset-0 bg-scrim-strong backdrop-blur-sm" onClick={onClose} />
        )}
        <motion.div
          className="relative z-10 w-full max-w-lg mx-4 bg-panel/95 backdrop-blur-xl border border-border-strong rounded-2xl shadow-modal overflow-hidden"
          initial={{ opacity: 0, scale: 0.97, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
          <div className="flex items-center justify-between px-6 pt-6 pb-2">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-accent-teal/10 rounded-lg text-accent-teal">
                {icon}
              </div>
              <div className="text-xs text-fg-dim">
                <span className="text-fg-strong font-semibold">{section.label}</span>
                {' · '}Step {step + 1} of {total}
                {mode === 'guided' && <span className="ml-1.5 text-[10px] text-accent-teal">guided</span>}
              </div>
            </div>
            <button onClick={onClose} className="p-1 text-fg-dim hover:text-fg-muted transition-colors" aria-label="Close tour">
              <X size={18} />
            </button>
          </div>

          <div className="px-6 py-4">
            <h2 className="text-xl font-bold text-fg-strong mb-3">{current.title}</h2>
            <p className="text-sm text-fg-subtle leading-relaxed">{current.body}</p>
          </div>

          <div className="flex items-center justify-between px-6 pb-6 pt-2">
            <div className="flex gap-1.5">
              {section.steps.map((_, i) => (
                <div key={i} className={cn('w-2 h-2 rounded-full transition-colors', i === step ? 'bg-accent-teal' : 'bg-panel-strong')} />
              ))}
            </div>
            <div className="flex items-center gap-2">
              {step > 0 && (
                <button onClick={() => setStep((s) => s - 1)} className="flex items-center gap-1 px-3 py-2 text-xs text-fg-subtle hover:text-fg-strong transition-colors">
                  <ChevronLeft size={14} /> Back
                </button>
              )}
              {step < total - 1 ? (
                <button onClick={() => setStep((s) => s + 1)} className="flex items-center gap-1.5 px-4 py-2 bg-accent-teal/20 text-accent-teal rounded-lg text-xs font-bold tracking-wider uppercase hover:bg-accent-teal/30 transition-colors">
                  Next <ChevronRight size={14} />
                </button>
              ) : (
                <button onClick={finish} className="flex items-center gap-1.5 px-4 py-2 bg-accent-blue text-white rounded-lg text-xs font-bold tracking-wider uppercase hover:opacity-90 transition-opacity">
                  Done <Check size={14} />
                </button>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </>
  );
}

/** Small picker used by WelcomeScreen — choose a section and a mode. Grouped into 3
 *  clusters for the 10-section tour so the list stays scannable at max-h-80. */
export function TourPicker({ onPick, onClose }: { onPick: (sectionId: string, mode: 'card' | 'guided') => void; onClose: () => void }) {
  const [mode, setMode] = useState<'card' | 'guided'>('guided');
  const taken = readToursTaken();
  const groups = (() => {
    if (TOUR_GROUPS && TOUR_GROUPS.length) {
      return TOUR_GROUPS.map((grp) => ({
        ...grp,
        sections: grp.sectionIds.map((id) => TOUR_SECTIONS.find((s) => s.id === id)).filter(Boolean) as TourSection[],
      })).filter((g) => g.sections.length > 0);
    }
    return [{ id: 'all', label: 'All tours', description: '', sections: TOUR_SECTIONS }];
  })();
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
    >
      <div className="absolute inset-0 bg-scrim-strong backdrop-blur-sm" onClick={onClose} />
      <motion.div
        className="relative z-10 w-full max-w-xl mx-4 bg-panel/95 backdrop-blur-xl border border-border-strong rounded-2xl shadow-modal overflow-hidden"
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-2">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-accent-teal/10 rounded-lg text-accent-teal"><Sparkles size={18} /></div>
            <div>
              <h2 className="text-lg font-bold text-fg-strong">Take the Tour</h2>
              <p className="text-[11px] text-fg-dim">10 sections · ~50 steps · grouped · pick guided or cards</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-fg-dim hover:text-fg-muted transition-colors"><X size={18} /></button>
        </div>
        <div className="px-6 py-4">
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={() => setMode('guided')}
              className={cn('flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors', mode === 'guided' ? 'bg-accent-teal/20 text-accent-teal' : 'bg-scrim-faint text-fg-dim hover:text-fg-strong')}
            >
              Guided (points at things)
            </button>
            <button
              onClick={() => setMode('card')}
              className={cn('flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors', mode === 'card' ? 'bg-accent-teal/20 text-accent-teal' : 'bg-scrim-faint text-fg-dim hover:text-fg-strong')}
            >
              Cards (simple)
            </button>
          </div>
          <div className="space-y-4 max-h-[420px] overflow-y-auto pr-1">
            {groups.map((grp) => (
              <div key={grp.id}>
                <div className="flex items-baseline gap-2 mb-1.5 px-1">
                  <span className="text-[11px] font-bold tracking-wider uppercase text-fg-dim">{grp.label}</span>
                  <span className="text-[11px] text-fg-faint">{grp.description}</span>
                  <span className="ml-auto text-[10px] text-fg-faint">{grp.sections.filter((s) => taken[s.id]).length}/{grp.sections.length} done</span>
                </div>
                <div className="space-y-1.5">
                  {grp.sections.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => onPick(s.id, mode)}
                      className="w-full flex items-start gap-2.5 px-3 py-2 rounded-xl border border-border-soft hover:border-accent-teal/50 transition-colors text-left"
                    >
                      <span className="text-accent-teal text-lg leading-none mt-0.5">{typeof s.steps[0].icon === 'string' ? s.steps[0].icon : '✦'}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-sm text-fg-strong">
                          {s.label}
                          {taken[s.id] && <span className="text-[9px] text-accent-green font-bold uppercase">done</span>}
                          <span className="ml-auto text-[10px] text-fg-faint">{s.steps.length} steps</span>
                        </span>
                        <span className="block text-[11px] text-fg-dim mt-0.5">{s.description}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between px-6 pb-6 pt-2">
          <span className="text-[11px] text-fg-faint">Guided opens Tools panels and dashboard for you.</span>
          <button onClick={onClose} className="px-4 py-2 text-xs text-fg-subtle hover:text-fg-strong transition-colors">Close</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

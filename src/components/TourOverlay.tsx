import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Check, ChevronLeft, ChevronRight, X, Sparkles } from 'lucide-react';
import { cn } from '../lib/utils';
import { TourSection, TourStep, markTourTaken, TOUR_SECTIONS, readToursTaken } from '../tours';

// Phase T2 (2026-08-14): the tour overlay — two modes per section:
//  - 'card': the classic modal-card steps (works from any view, zero app coupling);
//  - 'guided': card steps that ALSO drive the app — each step with `view` triggers a
//    custom 'lpc:tour-view' event (App.tsx switches the main view: tools/dashboard/chat)
//    and each step with `target` spotlights the real element (a `data-tour` attribute;
//    the overlay scrolls it into view and draws a ring around it). Steps without a
//    target render as plain cards inside the guided tour.
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

  // Guided mode: on each step change, switch the app view (if the step wants one) and
  // locate the target element for the spotlight ring.
  useEffect(() => {
    if (mode !== 'guided') return;
    if (current.view) {
      window.dispatchEvent(new CustomEvent('lpc:tour-view', { detail: { view: current.view } }));
    }
    if (current.target) {
      const el = document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const t = setTimeout(() => setTargetRect(el.getBoundingClientRect()), 350);
        return () => clearTimeout(t);
      }
    }
    setTargetRect(null);
  }, [step, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-measure on resize so the ring tracks the element.
  useEffect(() => {
    if (mode !== 'guided' || !current.target || !targetRect) return;
    const onResize = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`);
      if (el) setTargetRect(el.getBoundingClientRect());
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
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

/** Small picker used by WelcomeScreen — choose a section and a mode. */
export function TourPicker({ onPick, onClose }: { onPick: (sectionId: string, mode: 'card' | 'guided') => void; onClose: () => void }) {
  const [mode, setMode] = useState<'card' | 'guided'>('guided');
  const taken = readToursTaken();
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
    >
      <div className="absolute inset-0 bg-scrim-strong backdrop-blur-sm" onClick={onClose} />
      <motion.div
        className="relative z-10 w-full max-w-md mx-4 bg-panel/95 backdrop-blur-xl border border-border-strong rounded-2xl shadow-modal overflow-hidden"
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-2">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-accent-teal/10 rounded-lg text-accent-teal"><Sparkles size={18} /></div>
            <h2 className="text-lg font-bold text-fg-strong">Take the Tour</h2>
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
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {TOUR_SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => onPick(s.id, mode)}
                className="w-full flex items-start gap-2.5 px-3 py-2 rounded-xl border border-border-soft hover:border-accent-teal/50 transition-colors text-left"
              >
                <span className="text-accent-teal text-lg leading-none mt-0.5">{typeof s.steps[0].icon === 'string' ? s.steps[0].icon : '✦'}</span>
                <span className="min-w-0">
                  <span className="block text-sm text-fg-strong">
                    {s.label}
                    {taken[s.id] && <span className="ml-2 text-[9px] text-accent-green font-bold uppercase">done</span>}
                  </span>
                  <span className="block text-[11px] text-fg-dim mt-0.5">{s.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-end px-6 pb-6 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-xs text-fg-subtle hover:text-fg-strong transition-colors">Close</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

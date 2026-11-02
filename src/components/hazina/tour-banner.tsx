"use client";

/**
 * Guided-tour banner — renders the current step of the 3-minute proof
 * (Ask → Ground → Check → Confirm → Human review → Record). Lives above the
 * chat column and above the ops-console tabs; driven by src/lib/tour.ts.
 *
 * Never traps the presenter: Back / Next buttons and clickable step dots are
 * ALWAYS available (manual navigation), while real results auto-advance the
 * same underlying step counter. Step TOUR_COMPLETE renders a completion card
 * with restart / dismiss.
 */
import { useSyncExternalStore } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Map, RotateCcw, X } from "lucide-react";
import {
  TOUR_COMPLETE, TOUR_STEPS, endTour, jumpTourTo, nextTourStep, onTourChange, prevTourStep,
  restartTour, tourActive, tourStep, tourStepDef,
} from "@/lib/tour";

export function TourBanner({ tick }: { tick?: number }) {
  // localStorage IS an external store: bind it with useSyncExternalStore so
  // every tour-state write (custom event from src/lib/tour.ts — chat results,
  // citation clicks, officer decisions in ANY component) updates the banner
  // instantly, with no setState-in-effect and no stale step display. The
  // parent's `tick` prop remains as a belt-and-braces re-render trigger.
  const active = useSyncExternalStore(onTourChange, tourActive, () => false);
  const step = useSyncExternalStore(onTourChange, tourStep, () => 0);

  if (!active) return null;
  const def = tourStepDef(step);
  if (!def) return null;
  const complete = step === TOUR_COMPLETE;
  const progress = `${Math.min(step, TOUR_STEPS.length)}/${TOUR_STEPS.length}`;

  return (
    <div
      className={`rounded-2xl border p-3.5 sm:p-4 mb-3.5 backdrop-blur-xl shadow-[0_18px_50px_-24px_oklch(0.08_0.01_170/0.9)] ${
        complete
          ? "border-jade-700/60 bg-jade-950/30"
          : "hairline-gold border-gold-500/40 bg-vault-900/80"
      }`}
      data-testid="tour-banner"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${
              complete
                ? "border-jade-700/60 bg-jade-900/40"
                : "border-gold-500/45 bg-gold-500/12"
            }`}
          >
            {complete ? (
              <CheckCircle2 className="h-4 w-4 text-jade-300" />
            ) : (
              <Map className="h-4 w-4 text-gold-400" />
            )}
          </span>
          <div className="min-w-0 space-y-1.5">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className={`font-display text-sm font-semibold ${complete ? "text-jade-100" : "text-vault-50"}`}>{def.title}</span>
              {!complete && (
                <span className="text-[10px] font-mono text-gold-300 bg-gold-500/12 border border-gold-500/35 rounded-full px-2 py-0.5 tabular-nums">
                  step {progress}
                </span>
              )}
            </div>
            <p className={`text-xs leading-relaxed ${complete ? "text-jade-100/90" : "text-vault-200/90"}`}>{def.hint}</p>
            <p className="text-[11px] text-vault-300">
              <b className="text-jade-300 font-medium">Shows:</b> {def.shows}
            </p>
            <p className="text-[11px] text-vault-400">
              <b className="text-gold-300/90 font-medium">Does not prove:</b> {def.doesNotProve}
            </p>

            {/* step dots — clickable (manual jump), current step highlighted */}
            {!complete && (
              <div className="flex items-center gap-1.5 pt-1 flex-wrap" aria-label="Tour progress">
                {TOUR_STEPS.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      jumpTourTo(s.id);
                    }}
                    title={s.title}
                    aria-label={`Go to step ${s.id}: ${s.title}`}
                    className={`h-2 rounded-full transition-all ${
                      s.id === step
                        ? "w-6 bg-gold-400"
                        : s.id < step
                          ? "w-2 bg-jade-500 hover:bg-jade-400"
                          : "w-2 bg-vault-700 hover:bg-gold-600"
                    }`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
        <button
          onClick={() => {
            endTour();
          }}
          aria-label="Exit guided tour"
          className={`shrink-0 p-1.5 rounded-lg transition-colors ${complete ? "text-jade-300 hover:text-jade-100 hover:bg-jade-900/40" : "text-vault-400 hover:text-gold-200 hover:bg-vault-800"}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* manual navigation — the guarantee that you can NEVER get stuck */}
      <div className={`flex items-center gap-2 mt-3 pt-3 border-t flex-wrap ${complete ? "border-jade-800/50" : "border-vault-700/60"}`}>
        {complete ? (
          <>
            <button
              onClick={() => {
                restartTour();
              }}
              data-testid="tour-restart"
              className="flex items-center gap-1.5 text-xs font-medium text-jade-200 border border-jade-700/60 bg-jade-950/40 hover:bg-jade-900/50 rounded-full px-3.5 py-1.5 transition-colors"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Restart tour
            </button>
            <button
              onClick={() => {
                endTour();
              }}
              className="flex items-center gap-1.5 text-xs font-medium text-vault-300 border border-vault-600/70 bg-vault-850/60 hover:bg-vault-800 rounded-full px-3.5 py-1.5 transition-colors"
            >
              Dismiss
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => {
                prevTourStep();
              }}
              disabled={step <= 1}
              data-testid="tour-back"
              aria-label="Previous tour step"
              className="flex items-center gap-1 text-xs font-medium text-vault-200 border border-vault-600/70 bg-vault-850/60 hover:bg-vault-800 disabled:opacity-40 disabled:cursor-not-allowed rounded-full px-3.5 py-1.5 transition-colors"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </button>
            <button
              onClick={() => {
                nextTourStep();
              }}
              data-testid="tour-next"
              aria-label="Next tour step"
              className="flex items-center gap-1 text-xs font-medium text-vault-975 bg-gradient-to-br from-gold-400 to-gold-600 hover:from-gold-300 hover:to-gold-500 rounded-full px-3.5 py-1.5 transition-all shadow-[0_4px_16px_-4px_oklch(0.68_0.13_80/0.6)]"
            >
              {step === TOUR_STEPS.length ? "Finish" : "Next"} <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <span className="text-[10px] font-mono text-vault-500 ml-auto hidden sm:block">
              auto-advances on real results · manual nav always available
            </span>
          </>
        )}
      </div>
    </div>
  );
}

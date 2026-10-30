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
      className={`rounded-xl border p-3 sm:p-4 mb-3 ${complete ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}
      data-testid="tour-banner"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          {complete ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-700 shrink-0 mt-0.5" />
          ) : (
            <Map className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-sm font-semibold ${complete ? "text-emerald-900" : "text-amber-900"}`}>{def.title}</span>
              {!complete && (
                <span className="text-[10px] font-mono text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-2 py-0.5">
                  step {progress}
                </span>
              )}
            </div>
            <p className={`text-xs ${complete ? "text-emerald-900/90" : "text-amber-900/90"}`}>{def.hint}</p>
            <p className="text-[11px] text-emerald-800">
              <b>Shows:</b> {def.shows}
            </p>
            <p className="text-[11px] text-slate-600">
              <b>Does not prove:</b> {def.doesNotProve}
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
                        ? "w-5 bg-amber-600"
                        : s.id < step
                          ? "w-2 bg-amber-400 hover:bg-amber-500"
                          : "w-2 bg-amber-200 hover:bg-amber-300"
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
          className={`shrink-0 p-1 ${complete ? "text-emerald-700 hover:text-emerald-900" : "text-amber-700 hover:text-amber-900"}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* manual navigation — the guarantee that you can NEVER get stuck */}
      <div className="flex items-center gap-2 mt-2.5 pt-2.5 border-t border-amber-200/70 flex-wrap">
        {complete ? (
          <>
            <button
              onClick={() => {
                restartTour();
              }}
              data-testid="tour-restart"
              className="flex items-center gap-1 text-xs font-medium text-emerald-800 border border-emerald-300 bg-white hover:bg-emerald-100 rounded-full px-3 py-1"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Restart tour
            </button>
            <button
              onClick={() => {
                endTour();
              }}
              className="flex items-center gap-1 text-xs font-medium text-slate-600 border border-slate-300 bg-white hover:bg-slate-100 rounded-full px-3 py-1"
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
              className="flex items-center gap-1 text-xs font-medium text-amber-900 border border-amber-300 bg-white hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed rounded-full px-3 py-1"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </button>
            <button
              onClick={() => {
                nextTourStep();
              }}
              data-testid="tour-next"
              aria-label="Next tour step"
              className="flex items-center gap-1 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-full px-3 py-1"
            >
              {step === TOUR_STEPS.length ? "Finish" : "Next"} <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <span className="text-[10px] text-amber-700/70 ml-auto hidden sm:block">
              auto-advances on real results · manual nav always available
            </span>
          </>
        )}
      </div>
    </div>
  );
}

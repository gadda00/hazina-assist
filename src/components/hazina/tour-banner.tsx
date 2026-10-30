"use client";

/**
 * Guided-tour banner — renders the current step of the 3-minute proof
 * (Ask → Ground → Check → Confirm → Human review → Record). Lives above the
 * chat column and above the ops-console tabs; driven by src/lib/tour.ts.
 */
import { useEffect, useState } from "react";
import { Map, X } from "lucide-react";
import { tourActive, tourStep, tourStepDef, endTour, TOUR_STEPS } from "@/lib/tour";

export function TourBanner({ tick }: { tick?: number }) {
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    // localStorage must be read after mount (SSR renders no banner); the
    // parent's `tick` prop re-triggers this read whenever progress lands.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActive(tourActive());
    setStep(tourStep());
  }, [tick]);

  if (!active) return null;
  const def = tourStepDef(step);
  if (!def) return null;
  const progress = `${step}/${TOUR_STEPS.length}`;

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 sm:p-4 mb-3" data-testid="tour-banner">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <Map className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-amber-900">{def.title}</span>
              <span className="text-[10px] font-mono text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-2 py-0.5">
                step {progress}
              </span>
            </div>
            <p className="text-xs text-amber-900/90">{def.hint}</p>
            <p className="text-[11px] text-emerald-800">
              <b>Shows:</b> {def.shows}
            </p>
            <p className="text-[11px] text-slate-600">
              <b>Does not prove:</b> {def.doesNotProve}
            </p>
          </div>
        </div>
        <button
          onClick={() => {
            endTour();
            setActive(false);
          }}
          aria-label="Exit guided tour"
          className="text-amber-700 hover:text-amber-900 shrink-0 p-1"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

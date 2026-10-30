/**
 * Guided tour — the "3-minute proof" (deep-review Phase 4).
 *
 * A localStorage-backed step counter that follows ONE curated control journey
 * across BOTH app surfaces (customer chat → officer console):
 *
 *   Ask → Ground → Check → Confirm → Human review → Record
 *
 * Each step states WHAT control is being demonstrated and (per the review)
 * WHAT IT DOES NOT PROVE — the tour teaches honest scope, not just wow.
 * State is client-side only; auto-advancing is driven by real results
 * arriving (fee answers, refusals, OTP staging, approvals, audit
 * verification), never by timers.
 *
 * UX guarantee (fixed after "we get stuck at step 2"): the banner ALWAYS
 * offers manual navigation — Back / Next / clickable step dots — so a
 * presenter can never be trapped on a step whose auto-advance event hasn't
 * fired yet. Auto-advance and manual navigation compose: auto only ever
 * moves forward to the step after the one just completed; manual can also
 * jump back to re-show a step.
 */

const KEY = "hazina:tour";

/** Browsers only: fired on every tour-state write so any mounted TourBanner
 *  re-reads localStorage immediately — advances from ANY component (chat
 *  results, citation clicks, officer decisions) reflect instantly. */
const TOUR_CHANGE_EVENT = "hazina:tour-change";

function writeTour(value: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, value);
  window.dispatchEvent(new CustomEvent(TOUR_CHANGE_EVENT));
}

export interface TourStepDef {
  id: number;
  surface: "login" | "chat" | "officer";
  title: string;
  hint: string;
  shows: string;
  doesNotProve: string;
}

export const TOUR_STEPS: TourStepDef[] = [
  {
    id: 1,
    surface: "chat",
    title: "1 · Ask a tariff question",
    hint: "Click the “M-Pesa fee (Sheng)” quick prompt (or type your own fee question).",
    shows: "The model proposes; the FEE itself is computed by a deterministic tariff tool — never guessed.",
    doesNotProve: "Nothing about real Co-op Bank tariffs — the guide is synthetic demo data.",
  },
  {
    id: 2,
    surface: "chat",
    title: "2 · Inspect the evidence",
    hint: "Read the answer, then click a green citation to open its source excerpt, and read the “Why this answer” panel on the right. Or press Next to move on.",
    shows: "Every fee answer carries its source (tariff guide, effective date, page) and a node-by-node trace.",
    doesNotProve: "That citations are always correct in the wild — the eval gate covers the 55-case golden set.",
  },
  {
    id: 3,
    surface: "chat",
    title: "3 · Watch a safe refusal",
    hint: "Click the red “Injection probe” quick prompt.",
    shows: "Instruction attacks are refused before any tool or model call; the refusal lands on the audit chain.",
    doesNotProve: "Immunity to every future attack phrasing — it is a detector, not a proof.",
  },
  {
    id: 4,
    surface: "chat",
    title: "4 · Propose a transfer",
    hint: "Click “Transfer → HITL”. Note the fee is disclosed BEFORE you confirm, and the OTP step-up is raised.",
    shows: "The model can only PROPOSE: policy caps are checked deterministically and a signed intent is staged.",
    doesNotProve: "A real out-of-band SMS — in this demo the code is shown in the chat (synthetic channel).",
  },
  {
    id: 5,
    surface: "chat",
    title: "5 · Verify with the OTP",
    hint: "Type the 6-digit code from the demo SMS card into the OTP field and press Verify.",
    shows: "Only after step-up does the intent go to a human queue — money cannot move from chat alone.",
    doesNotProve: "Strong customer authentication — demo OTP is in-page, not a second factor.",
  },
  {
    id: 6,
    surface: "officer",
    title: "6 · Switch to the officer console",
    hint: "Sign out, then sign in as “Officer Njeri (Credit)” from the login screen.",
    shows: "The approval queue is server-side RBAC-protected — customers can never reach it.",
    doesNotProve: "Real officer identity — this demo uses a synthetic identity picker (demo IAM).",
  },
  {
    id: 7,
    surface: "officer",
    title: "7 · Approve with a deliberate confirmation",
    hint: "On the pending transfer, click Approve & execute and read the confirmation dialog before confirming.",
    shows: "A human decides; execution verifies HMAC signature, TTL and nonce, then debits atomically.",
    doesNotProve: "Production payment rails — the core banking API is a synthetic mock.",
  },
  {
    id: 8,
    surface: "officer",
    title: "8 · Verify the audit chain",
    hint: "Open the “Audit chain” tab and press “Verify chain”.",
    shows: "Every step of the journey is hash-chained; tampering with any event breaks verification.",
    doesNotProve: "Immutability against a privileged DB admin — the chain is tamper-evident, not immutable storage.",
  },
];

/** The step id that represents "all steps done" (tour complete). */
export const TOUR_COMPLETE = TOUR_STEPS.length + 1;

const COMPLETE_DEF: TourStepDef = {
  id: TOUR_COMPLETE,
  surface: "officer",
  title: "Tour complete — the 3-minute proof",
  hint: "Ask → Ground → Check → Confirm → Human review → Record: every control shown with its honest limits.",
  shows: "Fee determinism, citations, safe refusal, OTP step-up, human approval and a verified audit chain — end to end.",
  doesNotProve: "Production readiness — synthetic data, demo IAM and a mock core API throughout.",
};

export function tourActive(): boolean {
  if (typeof window === "undefined") return false;
  const v = window.localStorage.getItem(KEY);
  return v !== null && v !== "done";
}

/** Subscribe to tour-state changes (client-side). Returns an unsubscribe fn. */
export function onTourChange(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(TOUR_CHANGE_EVENT, cb);
  return () => window.removeEventListener(TOUR_CHANGE_EVENT, cb);
}

export function tourStep(): number {
  if (typeof window === "undefined") return 0;
  const v = parseInt(window.localStorage.getItem(KEY) ?? "0", 10);
  return Number.isFinite(v) ? v : 0;
}

export function startTour(): void {
  writeTour("1");
}

/** Restart from step 1 (offered on the completion card). */
export function restartTour(): void {
  writeTour("1");
}

export function endTour(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
  window.dispatchEvent(new CustomEvent(TOUR_CHANGE_EVENT));
}

/**
 * Auto-advance on REAL results only. No-ops when the tour is not active, so
 * normal (non-tour) usage never spawns a banner mid-session. Never moves
 * backwards — a real result for step N completes it and reveals step N+1.
 */
export function advanceTourTo(step: number): void {
  if (typeof window === "undefined") return;
  if (!tourActive()) return;
  if (step > tourStep() && step <= TOUR_COMPLETE) {
    writeTour(String(step));
  }
}

/** Manual navigation: forward one step (caps at the completion step). */
export function nextTourStep(): void {
  if (typeof window === "undefined") return;
  const cur = tourStep();
  if (cur >= 1) writeTour(String(Math.min(cur + 1, TOUR_COMPLETE)));
}

/** Manual navigation: back one step (presenter may want to re-show a step). */
export function prevTourStep(): void {
  if (typeof window === "undefined") return;
  const cur = tourStep();
  if (cur > 1) writeTour(String(cur - 1));
}

/** Manual jump (step dots). */
export function jumpTourTo(step: number): void {
  if (typeof window === "undefined") return;
  if (step >= 1 && step <= TOUR_COMPLETE) writeTour(String(step));
}

export function tourStepDef(step: number): TourStepDef | null {
  if (step === TOUR_COMPLETE) return COMPLETE_DEF;
  return TOUR_STEPS.find((s) => s.id === step) ?? null;
}

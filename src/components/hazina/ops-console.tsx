"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity, BadgeCheck, Ban, CheckCircle2, ClipboardCheck, FileSearch, FlaskConical,
  Gauge, Link2, Loader2, Lock, RefreshCw, ShieldCheck, Users,
} from "lucide-react";
import type {
  ApprovalTask, AuditEventView, EvalRunView, PayslipPackView, SessionInfo,
} from "@/lib/types";
import { apiFetch } from "@/lib/client-api";

type ConsoleTab = "approvals" | "packs" | "audit" | "evals" | "monitor";

export function OpsConsole({ session }: { session: SessionInfo }) {
  const [tab, setTab] = useState<ConsoleTab>("approvals");
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 lg:py-6">
      <div className="mb-4 flex items-center gap-2 flex-wrap">
        <Users className="h-5 w-5 text-emerald-800" />
        <h1 className="text-lg font-semibold text-slate-900">Operations console</h1>
        <span className="text-xs text-slate-500">
          human-in-the-loop, audit verification, evaluation & monitoring
        </span>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as ConsoleTab)}>
        <TabsList className="mb-4 flex-wrap h-auto">
          <TabsTrigger value="approvals" className="gap-1.5 data-[state=active]:bg-emerald-800 data-[state=active]:text-white">
            <ClipboardCheck className="h-4 w-4" /> Approval queue
          </TabsTrigger>
          <TabsTrigger value="packs" className="gap-1.5 data-[state=active]:bg-emerald-800 data-[state=active]:text-white">
            <FileSearch className="h-4 w-4" /> Loan packs
          </TabsTrigger>
          <TabsTrigger value="audit" className="gap-1.5 data-[state=active]:bg-emerald-800 data-[state=active]:text-white">
            <Lock className="h-4 w-4" /> Audit chain
          </TabsTrigger>
          <TabsTrigger value="evals" className="gap-1.5 data-[state=active]:bg-emerald-800 data-[state=active]:text-white">
            <FlaskConical className="h-4 w-4" /> Evaluations
          </TabsTrigger>
          <TabsTrigger value="monitor" className="gap-1.5 data-[state=active]:bg-emerald-800 data-[state=active]:text-white">
            <Gauge className="h-4 w-4" /> Monitoring
          </TabsTrigger>
        </TabsList>
        <TabsContent value="approvals">
          <ApprovalsTab />
        </TabsContent>
        <TabsContent value="packs">
          <PacksTab />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab sessionId={session.session.id} />
        </TabsContent>
        <TabsContent value="evals">
          <EvalsTab />
        </TabsContent>
        <TabsContent value="monitor">
          <MonitorTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approvals — HITL queue for transfers
// ---------------------------------------------------------------------------

function ApprovalsTab() {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<ApprovalTask[]>([]);
  const [packs, setPacks] = useState<PayslipPackView[]>([]);
  const [officer, setOfficer] = useState("Officer Njeri");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiFetch("/api/approvals").then((r) => r.json());
      setTasks(d.tasks ?? []);
      setPacks(d.packs ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const decide = useCallback(
    async (taskId: string, decision: "approve" | "reject") => {
      let reason: string | undefined;
      if (decision === "reject") {
        // required rejection reason — recorded on the task + audit chain
        reason = window.prompt("Rejection reason (required — recorded on the audit chain):") ?? "";
        if (!reason.trim()) {
          toast({ title: "Rejection reason required", description: "The audit chain records WHY a task was declined.", variant: "destructive" });
          return;
        }
        reason = reason.trim();
      }
      setActing(taskId + decision);
      try {
        const res = await apiFetch("/api/approvals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taskId, decision, officer, reason }),
        });
        const d = await res.json();
        if (d.ok) {
          toast({
            title: decision === "approve" ? "Transfer executed" : "Transfer rejected",
            description: d.replayed
              ? "Idempotent replay — original receipt returned, nothing double-debited."
              : d.txnRef
                ? `txn ${d.txnRef} · fee KES ${d.feeKes} · idempotency ${d.messageRef?.slice(0, 12)}…`
                : "The customer is notified; the audit chain records your decision.",
          });
        } else {
          toast({ title: "Execution rejected by controls", description: `reason: ${d.reason}`, variant: "destructive" });
        }
        await load();
      } catch {
        toast({ title: "Decision failed", variant: "destructive" });
      } finally {
        setActing(null);
      }
    },
    [load, officer, toast]
  );

  const open = tasks.filter((t) => t.status === "open");
  const decided = tasks.filter((t) => t.status !== "open").slice(0, 8);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-sm py-8 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" /> loading queue…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="border-slate-200">
        <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-600">
            <b className="text-slate-900">{open.length}</b> open task{open.length === 1 ? "" : "s"} awaiting a human decision.
            Transfers execute only after signature, expiry &amp; nonce verification.
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">acting as</span>
            <Input value={officer} onChange={(e) => setOfficer(e.target.value)} className="h-8 w-44" />
            <Button variant="outline" size="sm" onClick={load} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {open.length === 0 && (
        <div className="text-center text-sm text-slate-400 py-10 border border-dashed border-slate-200 rounded-xl">
          Queue is empty. Stage a transfer in the chat (quick prompt &ldquo;Transfer → HITL&rdquo;) to
          see the approval flow end-to-end.
        </div>
      )}

      {open.map((t) => {
        const p = t.payload as {
          customer?: string;
          fromAccount?: string;
          beneficiary?: string;
          destination?: string;
          destinationType?: string;
          purpose?: string;
          amountKes?: number;
          requestedAmountKes?: number;
          fileName?: string;
          netKes?: number;
          validationOk?: boolean;
        };
        return (
          <Card key={t.id} className="border-slate-200">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="border-violet-300 bg-violet-50 text-violet-700">
                      {t.type === "transfer" ? "Transfer intent" : "Loan pack"}
                    </Badge>
                    <RiskBadge risk={t.riskLevel} />
                    <span className="text-[11px] text-slate-400 font-mono">{t.id.slice(-8)}</span>
                  </div>
                  <div className="text-2xl font-semibold text-slate-900">
                    KES {Number(p.amountKes ?? p.requestedAmountKes ?? 0).toLocaleString()}
                  </div>
                  <div className="text-sm text-slate-600">
                    {t.type === "transfer" ? (
                      <>
                        {p.customer} · from {p.fromAccount} → <b>{p.beneficiary}</b>{" "}
                        <span className="font-mono text-xs">{String(p.destination)}</span> via{" "}
                        {String(p.destinationType).toUpperCase()}
                        {p.purpose ? ` · ${p.purpose}` : ""}
                      </>
                    ) : (
                      <>
                        {p.customer} · {p.fileName} · net KES {Number(p.netKes ?? 0).toLocaleString()} ·{" "}
                        validation {p.validationOk ? "passed" : "flagged"}
                      </>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="bg-emerald-700 hover:bg-emerald-600 gap-1.5"
                    disabled={!!acting}
                    onClick={() => decide(t.id, "approve")}
                  >
                    {acting === t.id + "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />}
                    Approve &amp; execute
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-red-300 text-red-700 hover:bg-red-50 gap-1.5"
                    disabled={!!acting}
                    onClick={() => decide(t.id, "reject")}
                  >
                    {acting === t.id + "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
                    Reject
                  </Button>
                </div>
              </div>
              <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                Execution verifies HMAC signature, TTL expiry and single-use nonce, then calls the core
                API with an idempotency key.
              </div>
            </CardContent>
          </Card>
        );
      })}

      {decided.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">recent decisions</div>
          {decided.map((t) => (
            <div key={t.id} className="flex items-center justify-between text-xs text-slate-500 border border-slate-100 rounded-lg px-3 py-2">
              <span className="font-mono">{t.id.slice(-8)}</span>
              <span>
                {t.type} · KES {Number(t.payload.amountKes ?? t.payload.requestedAmountKes ?? 0).toLocaleString()}
              </span>
              <span className="flex items-center gap-1.5">
                {t.status === "approved" ? (
                  <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> approved by {t.decidedBy}</>
                ) : (
                  <><Ban className="h-3.5 w-3.5 text-red-500" /> rejected{t.reason ? ` (${t.reason})` : ""}</>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RiskBadge({ risk }: { risk: string }) {
  const map: Record<string, string> = {
    low: "border-emerald-300 bg-emerald-50 text-emerald-700",
    medium: "border-amber-300 bg-amber-50 text-amber-700",
    high: "border-red-300 bg-red-50 text-red-700",
  };
  return <Badge variant="outline" className={map[risk] ?? map.low}>{risk} risk</Badge>;
}

// ---------------------------------------------------------------------------
// Loan packs — payslip extraction evidence + officer decision
// ---------------------------------------------------------------------------

function PacksTab() {
  const { toast } = useToast();
  const [packs, setPacks] = useState<PayslipPackView[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiFetch("/api/approvals").then((r) => r.json());
      setPacks(d.packs ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const decidePack = useCallback(
    async (packId: string, decision: "approve" | "reject") => {
      // find the approval task tied to this pack
      const d = await apiFetch("/api/approvals").then((r) => r.json());
      const task = (d.tasks as ApprovalTask[]).find((t) => t.type === "loan_pack" && t.refId === packId && t.status === "open");
      if (!task) {
        toast({ title: "No open task for this pack", variant: "destructive" });
        return;
      }
      await apiFetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: task.id, decision, officer: "Officer Njeri (Credit)" }),
      });
      toast({
        title: decision === "approve" ? "Loan recommended to approval" : "Loan declined",
        description: "The AI recommended; the officer decided — DPA s.35 compliant.",
      });
      load();
    },
    [load, toast]
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-sm py-8 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" /> loading packs…
      </div>
    );
  }

  if (packs.length === 0) {
    return (
      <div className="text-center text-sm text-slate-400 py-10 border border-dashed border-slate-200 rounded-xl">
        No payslip packs yet. In the chat, choose &ldquo;I want to apply for a loan&rdquo; then click a
        payslip sample button (clean or scanned) below the input box.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="border-slate-200 bg-slate-50">
        <CardContent className="p-4 text-sm text-slate-600">
          Extraction carries <b>per-field confidence</b> and the <b>source span</b> (evidence) from the
          document. Validation is deterministic (KRA PIN format, net ≤ gross, deductions reconcile,
          Employment Act one-third rule). Affordability is a computation, not a judgement. The system
          <b> recommends, never decides</b> — the credit officer clicks the final action.
        </CardContent>
      </Card>
      {packs.map((p) => (
        <Card key={p.id} className="border-slate-200">
          <CardContent className="p-4 space-y-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="border-slate-300">{p.docKind} payslip</Badge>
                  <Badge
                    variant="outline"
                    className={
                      p.status === "approved"
                        ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                        : p.status === "declined"
                          ? "border-red-300 bg-red-50 text-red-700"
                          : "border-amber-300 bg-amber-50 text-amber-700"
                    }
                  >
                    {p.status.replace(/_/g, " ")}
                  </Badge>
                  <span className="text-[11px] text-slate-400 font-mono">{p.fileName}</span>
                </div>
                <p className="text-sm text-slate-600 mt-2 max-w-2xl">{p.summary}</p>
              </div>
              {p.status === "awaiting_review" && (
                <div className="flex gap-2">
                  <Button size="sm" className="bg-emerald-700 hover:bg-emerald-600 gap-1.5" onClick={() => decidePack(p.id, "approve")}>
                    <BadgeCheck className="h-4 w-4" /> Recommend approve
                  </Button>
                  <Button size="sm" variant="outline" className="border-red-300 text-red-700 hover:bg-red-50 gap-1.5" onClick={() => decidePack(p.id, "reject")}>
                    <Ban className="h-4 w-4" /> Decline
                  </Button>
                </div>
              )}
            </div>

            {/* extracted fields with confidence + evidence */}
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {(
                [
                  ["employer", p.fields.employer],
                  ["employee", p.fields.employeeName],
                  ["KRA PIN", p.fields.kraPin],
                  ["gross", p.fields.gross],
                  ["net", p.fields.net],
                ] as [string, { value: unknown; confidence: number; evidence?: { page: number; span: string } | null }][]
              ).map(([label, f]) => (
                <div key={label} className="rounded-lg border border-slate-100 bg-white p-2.5">
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
                  <div className="font-mono text-sm text-slate-800 truncate">
                    {typeof f.value === "number" ? `KES ${f.value.toLocaleString()}` : String(f.value ?? "—")}
                  </div>
                  <div className="flex items-center gap-1 mt-1">
                    <div className="h-1 flex-1 rounded bg-slate-100 overflow-hidden">
                      <div
                        className={`h-full ${f.confidence >= 0.7 ? "bg-emerald-500" : "bg-amber-500"}`}
                        style={{ width: `${Math.round(f.confidence * 100)}%` }}
                      />
                    </div>
                    <span className={`text-[10px] font-mono ${f.confidence >= 0.7 ? "text-emerald-600" : "text-amber-600"}`}>
                      {f.confidence.toFixed(2)}
                    </span>
                  </div>
                  {f.evidence && (
                    <div className="text-[10px] text-slate-400 truncate mt-1" title={f.evidence.span}>
                      ↳ p.{f.evidence.page}: &ldquo;{f.evidence.span.slice(0, 46)}&rdquo;
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* validation rules */}
            <div className="space-y-1">
              {p.validation.rules.map((r) => (
                <div key={r.rule} className="flex items-center gap-2 text-[11px]">
                  {r.passed ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                  ) : (
                    <Ban className="h-3.5 w-3.5 text-red-500 shrink-0" />
                  )}
                  <span className="font-mono text-slate-600 w-36 shrink-0">{r.rule}</span>
                  <span className="text-slate-500">{r.detail}</span>
                </div>
              ))}
            </div>

            {/* affordability */}
            <div className="rounded-lg bg-emerald-950 text-emerald-100 p-3 grid sm:grid-cols-4 gap-3 text-[11px]">
              <div>
                <div className="text-emerald-400/70 uppercase tracking-wide text-[9px]">disposable / month</div>
                <div className="font-mono text-sm">KES {p.affordability.disposableMonthlyKes.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-emerald-400/70 uppercase tracking-wide text-[9px]">max prudent instalment</div>
                <div className="font-mono text-sm">KES {p.affordability.maxInstalmentKes.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-emerald-400/70 uppercase tracking-wide text-[9px]">proposed instalment</div>
                <div className="font-mono text-sm text-amber-300">KES {p.affordability.proposedInstalmentKes.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-emerald-400/70 uppercase tracking-wide text-[9px]">recommendation</div>
                <div className="font-mono text-sm">{p.affordability.recommendation.replace(/_/g, " ")}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audit chain viewer + verification
// ---------------------------------------------------------------------------

function AuditTab({ sessionId }: { sessionId: string }) {
  const { toast } = useToast();
  const [events, setEvents] = useState<AuditEventView[]>([]);
  const [verification, setVerification] = useState<{ ok: boolean; brokenAt: number | null; totalEvents: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterSession, setFilterSession] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = `/api/audit?limit=150${filterSession ? `&sessionId=${sessionId}` : ""}`;
      const d = await apiFetch(url).then((r) => r.json());
      setEvents(d.events ?? []);
      setVerification(d.verification ?? null);
    } finally {
      setLoading(false);
    }
  }, [filterSession, sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <Card className={verification?.ok ? "border-emerald-300 bg-emerald-50/60" : "border-red-300 bg-red-50/60"}>
        <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {verification?.ok ? (
              <ShieldCheck className="h-8 w-8 text-emerald-600" />
            ) : (
              <Activity className="h-8 w-8 text-red-600" />
            )}
            <div>
              <div className="font-medium text-slate-900">
                {verification?.ok
                  ? `Hash chain intact — ${verification.totalEvents} events verified`
                  : `CHAIN BROKEN at event #${verification?.brokenAt}`}
              </div>
              <div className="text-xs text-slate-500">
                Every event is SHA-256 chained to its predecessor (prev_hash + payload → hash).
                Recomputed on every read — tampering breaks the chain.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input type="checkbox" checked={filterSession} onChange={(e) => setFilterSession(e.target.checked)} className="accent-emerald-700" />
              this session only
            </label>
            <Button variant="outline" size="sm" onClick={load} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" /> Verify chain
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> reading chain…
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="grid grid-cols-[50px_110px_150px_1fr_130px] text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-100 px-3 py-2 font-medium">
            <span>#</span>
            <span>event</span>
            <span>actor</span>
            <span>payload (PII redacted)</span>
            <span className="text-right">hash</span>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {events.length === 0 && <div className="text-center text-sm text-slate-400 py-8">No events yet.</div>}
            {events.map((e) => (
              <button
                key={e.id}
                onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                className="w-full text-left grid grid-cols-[50px_110px_150px_1fr_130px] items-start gap-2 px-3 py-2 border-b border-slate-50 hover:bg-slate-50 text-[11px]"
              >
                <span className="text-slate-400 font-mono">{e.id}</span>
                <span className="font-mono text-slate-700">{e.eventType}</span>
                <span className="text-slate-500 truncate font-mono">{e.actor}</span>
                <span className={`font-mono ${expanded === e.id ? "whitespace-pre-wrap break-all" : "truncate"} text-slate-500`}>
                  {expanded === e.id ? JSON.stringify(e.payload, null, 1) : JSON.stringify(e.payload).slice(0, 120)}
                </span>
                <span className="text-right font-mono text-slate-400 flex items-center justify-end gap-1">
                  <Link2 className="h-3 w-3" />
                  {e.hash.slice(0, 10)}…
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evaluations — latest golden-set run
// ---------------------------------------------------------------------------

function EvalsTab() {
  const [run, setRun] = useState<EvalRunView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/api/eval")
      .then((r) => r.json())
      .then((d) => setRun(d.run))
      .finally(() => setLoading(false));
  }, []);

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-sm py-8 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" /> loading last run…
      </div>
    );
  }
  if (!run) {
    return (
      <div className="text-center text-sm text-slate-400 py-10 border border-dashed border-slate-200 rounded-xl">
        No evaluation run found. Run <code className="font-mono text-emerald-700">bun run eval</code> to
        execute the golden set through the production orchestrator.
      </div>
    );
  }

  const t = run.totals;
  const failed = run.cases.filter((c) => !c.passed);

  return (
    <div className="space-y-4">
      <Card className={run.passed ? "border-emerald-300 bg-emerald-50/50" : "border-red-300 bg-red-50/50"}>
        <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {run.passed ? <ShieldCheck className="h-8 w-8 text-emerald-600" /> : <Ban className="h-8 w-8 text-red-600" />}
            <div>
              <div className="font-medium text-slate-900">
                {run.passed ? "CI gate: PASS" : "CI gate: FAIL"} — {t.passed}/{t.total} cases
              </div>
              <div className="text-xs text-slate-500">
                run {run.id.slice(0, 12)}… · {new Date(run.startedAt).toLocaleString()} · model path: {run.model}
              </div>
            </div>
          </div>
          <div className="text-xs text-slate-500">
            gate thresholds: pass ≥ 90% · route ≥ 90% · refusal recall = 100% · fee numeric = 100%
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
        <MetricCard label="pass rate" value={pct(t.passRate)} good={t.passRate >= 0.9} />
        <MetricCard label="route acc." value={pct(t.routeAccuracy)} good={t.routeAccuracy >= 0.9} />
        <MetricCard label="tool exact" value={pct(t.toolExactMatch)} good={t.toolExactMatch >= 0.9} />
        <MetricCard label="refusal P" value={t.refusalPrecision.toFixed(2)} good={t.refusalPrecision >= 0.9} />
        <MetricCard label="refusal R" value={t.refusalRecall.toFixed(2)} good={t.refusalRecall >= 1} />
        <MetricCard label="citation" value={pct(t.citationRate)} good={t.citationRate >= 0.9} />
        <MetricCard label="fee numeric" value={pct(t.numericMatchRate)} good={t.numericMatchRate >= 1} />
        <MetricCard label="P50 / P95" value={`${t.latencyP50} / ${t.latencyP95}ms`} good />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-3">
              by language — EN / SW / code-mixed
            </div>
            <div className="space-y-2">
              {Object.entries(t.byLanguage).map(([lang, v]) => (
                <BarRow key={lang} label={lang} total={v.total} passed={v.passed} />
              ))}
            </div>
            <p className="text-[10px] text-slate-400 mt-3 leading-relaxed">
              African-language and code-mixed performance can lag English (IrokoBench) — failures here
              are first-class signals, not noise.
            </p>
          </CardContent>
        </Card>
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-3">by risk class</div>
            <div className="space-y-2">
              {Object.entries(t.byRisk).map(([risk, v]) => (
                <BarRow key={risk} label={risk} total={v.total} passed={v.passed} />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {failed.length > 0 && (
        <Card className="border-red-200">
          <CardContent className="p-4 space-y-2">
            <div className="text-xs font-medium text-red-700 uppercase tracking-wide">failed cases</div>
            {failed.map((c) => (
              <div key={c.id} className="text-[11px] text-slate-600">
                <b className="font-mono">{c.id}</b> ({c.lang}/{c.risk}) — {c.failures.join("; ")}
                <div className="text-slate-400">&ldquo;{c.input}&rdquo;</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="text-[11px] text-slate-400">
        Full report: <code className="font-mono text-emerald-700">docs/eval/eval-report.md</code> · harness:{" "}
        <code className="font-mono text-emerald-700">bun run eval</code> · CI gate runs on every PR.
      </div>
    </div>
  );
}

function MetricCard({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <Card className={`border ${good === false ? "border-red-200 bg-red-50" : "border-slate-200"}`}>
      <CardContent className="p-2.5">
        <div className="text-[9px] uppercase tracking-wide text-slate-400">{label}</div>
        <div className={`font-mono text-sm ${good === false ? "text-red-700" : "text-slate-900"}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function BarRow({ label, total, passed }: { label: string; total: number; passed: number }) {
  const rate = total ? passed / total : 1;
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-14 text-slate-500 capitalize">{label}</span>
      <div className="flex-1 h-2 rounded bg-slate-100 overflow-hidden">
        <div className={`h-full ${rate >= 0.9 ? "bg-emerald-500" : rate >= 0.7 ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${rate * 100}%` }} />
      </div>
      <span className="font-mono text-slate-500 w-16 text-right">{passed}/{total}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monitoring — live SLO/metrics from /api/metrics + /api/health
// ---------------------------------------------------------------------------

function MonitorTab() {
  const [metrics, setMetrics] = useState<Record<string, string> | null>(null);
  const [health, setHealth] = useState<{ status: string; dependencies: Record<string, string>; counts: Record<string, number> } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, h] = await Promise.all([
        apiFetch("/api/metrics").then((r) => r.text()),
        apiFetch("/api/health").then((r) => r.json()),
      ]);
      const parsed: Record<string, string> = {};
      for (const line of m.split("\n")) {
        if (line && !line.startsWith("#")) {
          const [k, v] = line.split(" ");
          if (k && v) parsed[k] = v;
        }
      }
      setMetrics(parsed);
      setHealth(h);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [load]);

  const get = (k: string) => metrics?.[k] ?? "—";

  return (
    <div className="space-y-4">
      <Card className="border-slate-200">
        <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Gauge className="h-5 w-5 text-emerald-700" />
            Live operational metrics — sourced from the audit chain, exposed in Prometheus format at{" "}
            <code className="font-mono text-[11px] text-emerald-700">/api/metrics</code>.
          </div>
          <Button variant="outline" size="sm" onClick={load} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </CardContent>
      </Card>

      {loading && !metrics ? (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> collecting metrics…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <MetricCard label="requests" value={get("hazina_requests_total")} />
            <MetricCard label="latency p50" value={`${get('hazina_request_latency_ms{quantile="0.5"}')}ms`} />
            <MetricCard label="latency p95" value={`${get('hazina_request_latency_ms{quantile="0.95"}')}ms`} />
            <MetricCard label="cost (usd)" value={`$${get("hazina_cost_usd_total")}`} />
            <MetricCard label="injection trips" value={get('hazina_guardrail_trips_total{kind="injection"}')} />
            <MetricCard label="PII detections" value={get('hazina_guardrail_trips_total{kind="pii_detected"}')} />
            <MetricCard label="refusals" value={get('hazina_guardrail_trips_total{kind="refusal"}')} />
            <MetricCard label="escalation rate" value={get("hazina_escalation_rate")} />
            <MetricCard label="HITL raised" value={get("hazina_hitl_raised_total")} />
            <MetricCard label="transfers executed" value={get("hazina_transfers_executed_total")} />
            <MetricCard label="OTP issued" value={get("hazina_otp_issued_total")} />
            <MetricCard label="audit events" value={get("hazina_audit_events_total")} />
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <Card className="border-slate-200">
              <CardContent className="p-4 space-y-2">
                <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">dependencies</div>
                {health && Object.entries(health.dependencies).map(([k, v]) => (
                  <div key={k} className="flex justify-between text-[11px]">
                    <span className="text-slate-500">{k}</span>
                    <span className={`font-mono ${v === "ok" ? "text-emerald-600" : "text-amber-600"}`}>{v}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card className="border-slate-200">
              <CardContent className="p-4 space-y-2">
                <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">SLO alerts (compose stack)</div>
                <ul className="text-[11px] text-slate-500 space-y-1.5">
                  <li>• P95 latency &gt; 3s for 5m → page on-call (error budget burn)</li>
                  <li>• refusal recall &lt; 1.0 in eval gate → block merge</li>
                  <li>• guardrail trip rate &gt; 5% of traffic → review injection patterns</li>
                  <li>• escalation rate drift &gt; ±20% week-over-week → tune answerability gate</li>
                </ul>
                <p className="text-[10px] text-slate-400">
                  Grafana dashboards ship in deploy/ (Prometheus scrapes /api/metrics).
                </p>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

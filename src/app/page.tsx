"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Shield, MessageSquare, Users, Loader2, LogOut, Lock, UserCog, Map, ChevronRight, Sparkles,
} from "lucide-react";
import { ChatView } from "@/components/hazina/chat-view";
import { OpsConsole } from "@/components/hazina/ops-console";
import { HazinaLogo, HazinaMark } from "@/components/hazina/logo";
import { apiFetch, setApiToken } from "@/lib/client-api";
import { startTour } from "@/lib/tour";
import type { SessionInfo } from "@/lib/types";

type View = "chat" | "console";

/* ------------------------------------------------------------------ *
 * Motion presets — restrained, cinematic entrances
 * ------------------------------------------------------------------ */
const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
};
const rise = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] as const } },
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

export default function Home() {
  const { toast } = useToast();
  const [view, setView] = useState<View>("chat");
  const [customers, setCustomers] = useState<
    { id: string; name: string; phone: string; accounts: { handle: string; type: string; maskedNumber: string }[] }[]
  >([]);
  const [officers, setOfficers] = useState<{ id: string; name: string; role: string }[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [directoryEmpty, setDirectoryEmpty] = useState(false);
  const [preparing, setPreparing] = useState(false); // demo DB is being rebuilt (auto-heal)
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loggingIn, setLoggingIn] = useState<string | null>(null);

  const loadDirectory = useCallback(async () => {
    setLoadError(false);
    setDirectoryEmpty(false);
    try {
      const r = await fetch("/api/auth/login");
      if (!r.ok) throw new Error("bad status");
      const d = await r.json();
      setCustomers(d.customers ?? []);
      setOfficers(d.officers ?? []);
      // Loaded fine but zero rows → the DB schema exists but was never seeded.
      // (The auto-heal normally rebuilds it server-side before this response;
      // if it could not, surface the exact fix instead of an infinite spinner.)
      if ((d.customers ?? []).length === 0 && (d.officers ?? []).length === 0) {
        setDirectoryEmpty(true);
      }
      // Auto-heal in progress (fresh/re-provisioned DB): poll until the demo
      // state is fully staged, then re-read the directory.
      const st = d.demoState as string | undefined;
      if (st && st !== "ready") {
        setPreparing(true);
        setTimeout(() => void loadDirectory(), 2000);
      } else {
        setPreparing(false);
      }
    } catch {
      setLoadError(true);
      toast({ title: "Could not load demo directory", description: "Retry in a moment.", variant: "destructive" });
    }
  }, [toast]);

  useEffect(() => {
    loadDirectory();
  }, [loadDirectory]);

  const login = useCallback(
    async (customerId: string, as: "customer" | "officer" = "customer", opts?: { tour?: boolean }) => {
      setLoggingIn(customerId + as);
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ customerId, as }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error?.message ?? d.error ?? "login failed");
        setApiToken(d.session.token);
        setSession(d as SessionInfo);
        setView(as === "officer" ? "console" : "chat");
        if (opts?.tour) startTour();
        toast({
          title:
            as === "officer"
              ? `Officer console — ${d.customer.name}`
              : `Signed in as ${d.customer.name}`,
          description:
            as === "officer"
              ? "Officer session — approvals, audit, evals and monitoring."
              : "Session opened — audit chain starts here.",
        });
      } catch (e) {
        toast({
          title: "Login failed",
          description: e instanceof Error ? e.message : "Please try again.",
          variant: "destructive",
        });
      } finally {
        setLoggingIn(null);
      }
    },
    [toast]
  );

  const logout = useCallback(async () => {
    if (session) {
      // best-effort server-side revocation (token already attached)
      try {
        await apiFetch("/api/auth/logout", { method: "PUT" });
      } catch {
        /* revocation is best-effort; clearing local state always proceeds */
      }
    }
    setApiToken(null);
    setSession(null);
    setView("chat");
  }, [session]);

  // -----------------------------------------------------------------------
  // Login screen — the vault door. Customers + a labelled demo-officer entry
  // -----------------------------------------------------------------------
  if (!session) {
    return (
      <div className="relative min-h-screen flex flex-col bg-vault-975 overflow-hidden">
        {/* --- atmosphere: aurora field, engraved guilloché, grain, vignette --- */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute -top-48 -left-40 h-[36rem] w-[36rem] rounded-full bg-jade-600/25 blur-[130px] animate-aurora-a" />
          <div className="absolute top-1/4 -right-48 h-[40rem] w-[40rem] rounded-full bg-gold-600/14 blur-[140px] animate-aurora-b" />
          <div className="absolute -bottom-64 left-1/4 h-[32rem] w-[32rem] rounded-full bg-jade-800/35 blur-[120px] animate-aurora-c" />
          <div className="absolute inset-0 guilloche" />
          <div className="absolute inset-0 noise" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_42%,oklch(0.105_0.012_170)_100%)]" />
        </div>

        <main className="relative flex-1 flex items-center justify-center p-4 sm:p-8 lg:p-12">
          <div className="w-full max-w-6xl grid lg:grid-cols-[1.08fr_minmax(400px,0.92fr)] gap-10 lg:gap-16 items-center">
            {/* ------------------------- left: the promise ------------------------- */}
            <motion.div variants={stagger} initial="hidden" animate="show" className="text-vault-50 space-y-7 min-w-0 order-2 lg:order-1">
              <motion.div variants={rise} className="flex items-center gap-4">
                <HazinaLogo />
              </motion.div>

              <motion.div variants={rise}>
                <div className="font-mono text-[11px] tracking-[0.35em] uppercase text-gold-400/90 mb-4">
                  Hazina · Swahili for &ldquo;treasure&rdquo;
                </div>
                <h1 className="font-display font-semibold leading-[1.04] tracking-tight text-4xl sm:text-5xl xl:text-[3.6rem]">
                  Banking intelligence,
                  <br />
                  <em className="font-normal italic text-shimmer">vaulted.</em>
                </h1>
              </motion.div>

              <motion.p variants={rise} className="text-vault-200/90 leading-relaxed max-w-md text-[15px]">
                An assistant that answers policy and tariff questions with citations, reads accounts
                through scoped tools, and stages transfers that only move after OTP step-up and a
                human officer&rsquo;s approval. Every step is hash-chained to an audit log.
              </motion.p>

              <motion.ul variants={rise} className="space-y-3 max-w-md">
                {[
                  "The model proposes — deterministic policy and humans decide",
                  "Fee answers computed from the tariff table, never guessed",
                  "PII pseudonymised before any external model call",
                  "Out-of-scope questions hand off instead of guessing",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-3 text-sm text-vault-100/85">
                    <span className="mt-0.5 shrink-0 flex h-5 w-5 items-center justify-center rounded-full border border-gold-500/40 bg-gold-500/10">
                      <Shield className="h-3 w-3 text-gold-400" />
                    </span>
                    <span>{t}</span>
                  </li>
                ))}
              </motion.ul>

              {/* trust strip — real, verifiable claims from the repo */}
              <motion.div
                variants={rise}
                className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-1 max-w-md border-t border-vault-700/60"
              >
                {[
                  ["134/134", "self-verify checks"],
                  ["100%", "refusal-recall gate"],
                  ["SHA-256", "hash-chained audit"],
                ].map(([v, l], i) => (
                  <div key={l} className={`flex items-baseline gap-1.5 ${i > 0 ? "sm:border-l sm:border-vault-700/60 sm:pl-5" : ""}`}>
                    <span className="font-mono text-sm font-medium text-gold-300">{v}</span>
                    <span className="text-[11px] text-vault-400">{l}</span>
                  </div>
                ))}
              </motion.div>

              <motion.p variants={rise} className="text-[11px] leading-relaxed text-vault-400/80 max-w-md border-l-2 border-jade-700/60 pl-3">
                Synthetic data only. This demo illustrates controls aligned to CBK&rsquo;s draft
                risk-management instruments (model risk, data governance, third parties) and the
                Data Protection Act 2019 (s.35 automated decisions, s.48 cross-border safeguards).
              </motion.p>
            </motion.div>

            {/* ------------------------- right: the door ------------------------- */}
            <motion.div
              initial={{ opacity: 0, y: 24, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.65, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
              className="order-1 lg:order-2 min-w-0"
            >
              <Card className="hairline-gold rounded-2xl border-vault-700/60 glass shadow-[0_40px_90px_-30px_oklch(0.08_0.01_170/0.95)]">
                <CardContent className="p-6 sm:p-7 space-y-6">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-gold-500/40 bg-gold-500/10">
                        <Lock className="h-4 w-4 text-gold-400" />
                      </span>
                      <span className="font-display text-xl font-semibold text-vault-50">Sign in to the vault</span>
                    </div>
                    <p className="text-[13px] leading-relaxed text-vault-200/85">
                      Pick a synthetic customer. In production this screen is Keycloak OIDC; scopes{" "}
                      (<code className="font-mono text-gold-300 text-[11px]">accounts:read</code>,{" "}
                      <code className="font-mono text-gold-300 text-[11px]">fees:read</code>,{" "}
                      <code className="font-mono text-gold-300 text-[11px]">transfers:propose</code>) are attached
                      server-side to a signed session — never to a client-supplied id.
                    </p>
                  </div>

                  <div className="space-y-3">
                    {preparing && (
                      <div className="flex items-center gap-2.5 text-vault-200 text-[13px] rounded-xl border border-jade-700/50 bg-jade-900/25 p-3">
                        <Loader2 className="h-4 w-4 animate-spin text-jade-400" />
                        Preparing the demo database — one moment (seeding the curated showcase)…
                      </div>
                    )}
                    {customers.map((c, i) => (
                      <button
                        key={c.id}
                        onClick={() => login(c.id)}
                        disabled={loggingIn !== null}
                        style={{ animationDelay: `${0.3 + i * 0.07}s` }}
                        className="w-full text-left rounded-xl border border-vault-700/70 bg-vault-850/60 hover:bg-vault-800/80 hover:border-gold-500/45 transition-all duration-200 p-3.5 group focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400/70 hover:translate-x-0.5 disabled:opacity-60"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <span
                              className={`h-9 w-9 shrink-0 rounded-full flex items-center justify-center font-mono text-[13px] font-semibold text-vault-975 bg-gradient-to-br ${
                                i % 3 === 0
                                  ? "from-jade-300 to-jade-600"
                                  : i % 3 === 1
                                    ? "from-gold-200 to-gold-500"
                                    : "from-vault-200 to-vault-500"
                              }`}
                            >
                              {initials(c.name)}
                            </span>
                            <div className="min-w-0">
                              <div className="font-medium text-vault-50 group-hover:text-gold-200 transition-colors truncate">{c.name}</div>
                              <div className="text-[11px] font-mono text-vault-300 mt-0.5 truncate">
                                {c.phone} · {c.accounts.map((a) => a.handle).join(", ")}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {c.accounts.map((a) => (
                              <Badge
                                key={a.handle}
                                variant="outline"
                                className="border-jade-700/60 bg-jade-900/30 text-jade-300 text-[10px] font-mono uppercase tracking-wide"
                              >
                                {a.type}
                              </Badge>
                            ))}
                            {loggingIn === c.id + "customer" ? (
                              <Loader2 className="h-4 w-4 animate-spin text-jade-400" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-vault-500 group-hover:text-gold-400 transition-colors" />
                            )}
                          </div>
                        </div>
                      </button>
                    ))}
                    {customers.length === 0 && !loadError && !directoryEmpty && (
                      <div className="flex items-center gap-2 text-vault-400 text-sm px-1">
                        <Loader2 className="h-4 w-4 animate-spin" /> loading customers…
                      </div>
                    )}
                    {directoryEmpty && !preparing && (
                      <div className="rounded-xl border border-gold-600/40 bg-gold-900/15 p-4 space-y-1.5">
                        <div className="text-sm font-medium text-gold-200">Demo directory is empty</div>
                        <p className="text-xs text-vault-300/70 leading-relaxed">
                          The database schema is in place but has no synthetic customers yet. Run{" "}
                          <code className="font-mono text-gold-300">bun run seed</code> in the project root
                          (see README → Quickstart), then reload this page to pick a demo identity.
                        </p>
                      </div>
                    )}
                    {loadError && (
                      <Button
                        variant="outline"
                        onClick={loadDirectory}
                        className="w-full border-vault-600 text-vault-200 hover:bg-vault-800 hover:text-vault-50"
                      >
                        <Loader2 className="h-4 w-4" /> Retry loading demo directory
                      </Button>
                    )}
                  </div>

                  {/* ------- guided tour: the 3-minute proof (product rec #1) ------- */}
                  <div className="pt-5 border-t border-vault-700/60 space-y-3.5">
                    <div className="flex items-center gap-2">
                      <Map className="h-4 w-4 text-gold-400" />
                      <span className="text-sm font-medium text-vault-100">Guided tour — the 3-minute proof</span>
                    </div>
                    <p className="text-xs leading-relaxed text-vault-300">
                      One curated journey, with the guide rail on: ask a tariff question → see the citation
                      and deterministic fee → watch a safe refusal → propose a transfer → OTP → switch to
                      the officer console → approve → verify the audit chain. Each step says what it shows
                      <i> and what it does not prove</i>.
                    </p>
                    <button
                      onClick={() => {
                        // the tour is scripted around Amina (established beneficiary
                        // Jane → the transfer step flows to OTP + approval)
                        const amina = customers.find((c) => c.name.startsWith("Amina")) ?? customers[0];
                        if (amina) login(amina.id, "customer", { tour: true });
                      }}
                      disabled={loggingIn !== null || customers.length === 0}
                      className="w-full text-left rounded-xl border border-gold-500/50 bg-gradient-to-r from-gold-500/20 via-gold-500/10 to-jade-600/10 hover:from-gold-500/30 hover:to-jade-600/20 hover:border-gold-400/70 transition-all duration-200 p-4 group focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400/70 disabled:opacity-60"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <Sparkles className="h-5 w-5 shrink-0 text-gold-400 group-hover:scale-110 transition-transform" />
                          <div className="min-w-0">
                            <div className="font-medium text-gold-100 group-hover:text-gold-50 text-sm">
                              Start the guided tour{(customers.find((c) => c.name.startsWith("Amina")) ?? customers[0])?.name
                                ? ` as ${(customers.find((c) => c.name.startsWith("Amina")) ?? customers[0]).name.split(" ")[0]}`
                                : ""}
                            </div>
                            <div className="text-[11px] text-vault-300/90 mt-0.5">
                              8 steps · chat → officer console · exit any time
                            </div>
                          </div>
                        </div>
                        {loggingIn !== null ? (
                          <Loader2 className="h-4 w-4 animate-spin text-gold-400" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-gold-500/70 group-hover:text-gold-300 group-hover:translate-x-0.5 transition-all" />
                        )}
                      </div>
                    </button>
                  </div>

                  {/* ------- demo officer console entry (clearly labelled) ------- */}
                  <div className="pt-5 border-t border-vault-700/60 space-y-3.5">
                    <div className="flex items-center gap-2">
                      <UserCog className="h-4 w-4 text-gold-400/90" />
                      <span className="text-sm font-medium text-gold-200/90">Demo officer console</span>
                    </div>
                    <p className="text-xs leading-relaxed text-vault-300">
                      A separate officer session for the human-in-the-loop queue, audit chain,
                      evaluations and monitoring. Customers can never reach these endpoints — the
                      role check is server-side.
                    </p>
                    {officers.map((o) => (
                      <button
                        key={o.id}
                        onClick={() => login(o.id, "officer")}
                        disabled={loggingIn !== null}
                        className="w-full text-left rounded-xl border border-gold-700/35 bg-gold-900/12 hover:bg-gold-900/25 hover:border-gold-500/55 transition-all duration-200 p-3.5 group focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400/70 hover:translate-x-0.5 disabled:opacity-60"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="h-9 w-9 shrink-0 rounded-full flex items-center justify-center border border-gold-500/40 bg-gold-500/15">
                              <Users className="h-4 w-4 text-gold-300" />
                            </span>
                            <div className="min-w-0">
                              <div className="font-medium text-gold-100 group-hover:text-gold-50 text-sm truncate">{o.name}</div>
                              <div className="text-[11px] font-mono text-vault-300 mt-0.5">role: {o.role}</div>
                            </div>
                          </div>
                          {loggingIn === o.id + "officer" ? (
                            <Loader2 className="h-4 w-4 animate-spin text-gold-400" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-vault-500 group-hover:text-gold-400 transition-colors" />
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          </div>
        </main>

        <footer className="relative text-center font-mono text-[11px] tracking-wide text-vault-500 py-5">
          Hazina Assist demo · synthetic data · guardrails, HITL, audit, evaluation
        </footer>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Authenticated app shell: customers see the chat; officers see the console
  // -----------------------------------------------------------------------
  const isOfficer = session.session.role === "officer";
  return (
    <div className="relative min-h-screen flex flex-col bg-vault-950 text-vault-100">
      {/* subtle atmosphere for the working surface */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-72 spotlight-jade" />

      <header className="sticky top-0 z-40 border-b border-gold-500/15 bg-vault-975/85 backdrop-blur-xl">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <HazinaMark className="h-9 w-9 shrink-0 drop-shadow-[0_2px_8px_oklch(0.55_0.11_163/0.35)]" />
            <div className="min-w-0">
              <div className="font-display font-semibold leading-tight truncate text-vault-50">Hazina Assist</div>
              <div className="text-[11px] font-mono text-vault-400 truncate">
                {isOfficer ? (
                  <span className="text-gold-300 font-medium tracking-wide">DEMO OFFICER MODE</span>
                ) : (
                  <>
                    {session.customer.name} · {session.accounts.map((a) => a.handle).join(" · ")}
                  </>
                )}
              </div>
            </div>
          </div>
          <nav className="flex items-center gap-2 sm:gap-3">
            <div className="flex rounded-xl bg-vault-850/80 border border-vault-700/60 p-1">
              {!isOfficer && (
                <button
                  onClick={() => setView("chat")}
                  className={`flex items-center gap-1.5 px-3 sm:px-4 py-1.5 rounded-lg text-sm transition-all ${
                    view === "chat"
                      ? "bg-jade-600/90 text-white shadow-[0_2px_12px_-2px_oklch(0.55_0.11_163/0.7)]"
                      : "text-vault-300 hover:text-vault-100"
                  }`}
                >
                  <MessageSquare className="h-4 w-4" />
                  <span className="hidden sm:inline">Chat</span>
                </button>
              )}
              {isOfficer && (
                <button
                  onClick={() => setView("console")}
                  className={`flex items-center gap-1.5 px-3 sm:px-4 py-1.5 rounded-lg text-sm transition-all ${
                    view === "console"
                      ? "bg-gold-500/90 text-vault-975 font-medium shadow-[0_2px_12px_-2px_oklch(0.68_0.13_80/0.7)]"
                      : "text-vault-300 hover:text-vault-100"
                  }`}
                >
                  <Users className="h-4 w-4" />
                  <span className="hidden sm:inline">Ops console</span>
                </button>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={logout}
              className="border-vault-600 text-vault-300 hover:bg-vault-800 hover:text-gold-200 hover:border-gold-600/50"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </nav>
        </div>
      </header>

      {isOfficer && (
        <div className="bg-gold-500/10 border-b border-gold-500/20 text-gold-200 text-xs sm:text-sm px-4 py-2 text-center">
          <strong className="font-medium">Demo officer console</strong> — you are acting as {session.customer.name}. Approval
          decisions execute the staged (OTP-verified) intents; every action lands on the audit chain.
        </div>
      )}

      <main className="relative flex-1">
        {view === "chat" && !isOfficer ? (
          <ChatView session={session} />
        ) : (
          <OpsConsole session={session} />
        )}
      </main>

      <footer className="relative border-t border-vault-700/50 bg-vault-975/60">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-vault-500">
          <span className="flex items-center gap-2">
            <HazinaMark className="h-4 w-4" />
            Session {session.session.id.slice(0, 14)}… · audit chain active
          </span>
          <span className="hidden md:inline">
            Controls aligned to CBK draft instruments · DPA 2019 s.35 &ldquo;recommend, not decide&rdquo; ·
            OWASP LLM Top 10
          </span>
        </div>
      </footer>
    </div>
  );
}

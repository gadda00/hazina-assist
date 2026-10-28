"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Shield, Landmark, MessageSquare, Users, Loader2, LogOut, Lock } from "lucide-react";
import { ChatView } from "@/components/hazina/chat-view";
import { OpsConsole } from "@/components/hazina/ops-console";
import type { SessionInfo } from "@/lib/types";

type View = "chat" | "console";

export default function Home() {
  const { toast } = useToast();
  const [view, setView] = useState<View>("chat");
  const [customers, setCustomers] = useState<{ id: string; name: string; phone: string; accounts: { handle: string; type: string; maskedNumber: string }[] }[]>([]);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    fetch("/api/auth/login")
      .then((r) => r.json())
      .then((d) => setCustomers(d.customers ?? []))
      .catch(() => toast({ title: "Could not load demo customers", variant: "destructive" }));
  }, [toast]);

  const login = useCallback(
    async (customerId: string) => {
      setLoggingIn(true);
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ customerId }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error);
        setSession(d as SessionInfo);
        toast({ title: `Signed in as ${d.customer.name}`, description: "Session opened — audit chain starts here." });
      } catch {
        toast({ title: "Login failed", variant: "destructive" });
      } finally {
        setLoggingIn(false);
      }
    },
    [toast]
  );

  const logout = useCallback(() => {
    setSession(null);
    setView("chat");
  }, []);

  // -----------------------------------------------------------------------
  // Login screen
  // -----------------------------------------------------------------------
  if (!session) {
    return (
      <div className="min-h-screen flex flex-col bg-gradient-to-br from-emerald-950 via-emerald-900 to-teal-950">
        <main className="flex-1 flex items-center justify-center p-4 sm:p-8">
          <div className="w-full max-w-5xl grid lg:grid-cols-2 gap-8 items-center">
            <div className="text-white space-y-6">
              <div className="flex items-center gap-3">
                <div className="h-12 w-12 rounded-xl bg-amber-400/20 border border-amber-300/30 flex items-center justify-center">
                  <Landmark className="h-6 w-6 text-amber-300" />
                </div>
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">Hazina Assist</h1>
                  <p className="text-emerald-200/80 text-sm">Bank-grade AI assistant · demo environment</p>
                </div>
              </div>
              <p className="text-emerald-100/90 leading-relaxed max-w-md">
                An assistant that answers policy and tariff questions with citations, reads accounts
                through scoped tools, and stages transfers that only move after OTP step-up and a
                human officer&rsquo;s approval. Every step is hash-chained to an audit log.
              </p>
              <ul className="space-y-2 text-sm text-emerald-100/80">
                {[
                  "The model proposes — deterministic policy and humans decide",
                  "Fee answers computed from the tariff table, never guessed",
                  "PII pseudonymised before any external model call",
                  "Out-of-scope questions hand off instead of guessing",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2">
                    <Shield className="h-4 w-4 mt-0.5 text-amber-300 shrink-0" />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-emerald-300/60 max-w-md border-l-2 border-emerald-700 pl-3">
                Synthetic data only. This demo illustrates controls aligned to CBK&rsquo;s draft
                risk-management instruments (model risk, data governance, third parties) and the
                Data Protection Act 2019 (s.35 automated decisions, s.48 cross-border safeguards).
              </p>
            </div>

            <Card className="border-emerald-800/40 bg-emerald-950/60 backdrop-blur">
              <CardContent className="p-6 space-y-5">
                <div className="flex items-center gap-2 text-emerald-200">
                  <Lock className="h-4 w-4" />
                  <span className="text-sm font-medium">Sign in to the demo (OIDC stub)</span>
                </div>
                <p className="text-sm text-emerald-100/70">
                  Pick a synthetic customer. In production this screen is Keycloak OIDC; scopes
                  (<code className="text-amber-300">accounts:read</code>,{" "}
                  <code className="text-amber-300">fees:read</code>,{" "}
                  <code className="text-amber-300">transfers:propose</code>) are attached server-side.
                </p>
                <div className="space-y-3">
                  {customers.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => login(c.id)}
                      disabled={loggingIn}
                      className="w-full text-left rounded-lg border border-emerald-800/60 bg-emerald-900/50 hover:bg-emerald-800/60 hover:border-emerald-600 transition p-4 group"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-medium text-white group-hover:text-amber-200">{c.name}</div>
                          <div className="text-xs text-emerald-300/70 mt-0.5">
                            {c.phone} · {c.accounts.map((a) => a.handle).join(", ")}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {c.accounts.map((a) => (
                            <Badge key={a.handle} variant="outline" className="border-emerald-700 text-emerald-300 text-[10px]">
                              {a.type}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </button>
                  ))}
                  {customers.length === 0 && (
                    <div className="flex items-center gap-2 text-emerald-300 text-sm">
                      <Loader2 className="h-4 w-4 animate-spin" /> loading customers…
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </main>
        <footer className="text-center text-xs text-emerald-300/50 py-4">
          Hazina Assist demo · synthetic data · guardrails, HITL, audit, evaluation
        </footer>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Authenticated app shell: chat + ops console
  // -----------------------------------------------------------------------
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <header className="sticky top-0 z-40 border-b border-emerald-900/10 bg-emerald-950 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-lg bg-amber-400/20 border border-amber-300/30 flex items-center justify-center shrink-0">
              <Landmark className="h-5 w-5 text-amber-300" />
            </div>
            <div className="min-w-0">
              <div className="font-semibold leading-tight truncate">Hazina Assist</div>
              <div className="text-[11px] text-emerald-300/80 truncate">
                {session.customer.name} · {session.accounts.map((a) => a.handle).join(" · ")}
              </div>
            </div>
          </div>
          <nav className="flex items-center gap-1 sm:gap-2">
            <div className="flex rounded-lg bg-emerald-900/60 p-1">
              <button
                onClick={() => setView("chat")}
                className={`flex items-center gap-1.5 px-3 sm:px-4 py-1.5 rounded-md text-sm transition ${
                  view === "chat" ? "bg-emerald-700 text-white" : "text-emerald-200 hover:text-white"
                }`}
              >
                <MessageSquare className="h-4 w-4" />
                <span className="hidden sm:inline">Chat</span>
              </button>
              <button
                onClick={() => setView("console")}
                className={`flex items-center gap-1.5 px-3 sm:px-4 py-1.5 rounded-md text-sm transition ${
                  view === "console" ? "bg-emerald-700 text-white" : "text-emerald-200 hover:text-white"
                }`}
              >
                <Users className="h-4 w-4" />
                <span className="hidden sm:inline">Ops console</span>
              </button>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={logout}
              className="border-emerald-700 text-emerald-200 hover:bg-emerald-900 hover:text-white"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {view === "chat" ? (
          <ChatView session={session} />
        ) : (
          <OpsConsole session={session} />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>Session {session.session.id.slice(0, 14)}… · audit chain active</span>
          <span>
            Controls aligned to CBK draft instruments · DPA 2019 s.35 &ldquo;recommend, not decide&rdquo; ·
            OWASP LLM Top 10
          </span>
        </div>
      </footer>
    </div>
  );
}

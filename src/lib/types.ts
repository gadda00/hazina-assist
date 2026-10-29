/** Shared client-side types mirroring the API contracts. */

export interface SessionInfo {
  session: { id: string; token: string; role: "customer" | "officer"; createdAt: string };
  customer: { id: string; name: string; phone?: string; role?: string };
  accounts: { handle: string; maskedNumber: string; type: string; currency: string }[];
  beneficiaries: { name: string; destinationType: string; masked: string; established: boolean }[];
}

export interface Citation {
  docId: string;
  page: number;
  title: string;
  breadcrumb: string;
  effectiveDate?: string;
  snippet?: string;
}

export interface ChatTrace {
  route?: string;
  kind?: string;
  guard?: {
    piiDetected?: string[];
    injectionScore?: number;
    injectionSignals?: string[];
    blocked?: boolean;
    lang?: string;
    outputGuard?: { groundednessScore: number; pass: boolean };
  };
  citations?: Citation[];
  toolCalls?: { name: string; args: Record<string, unknown>; resultSummary: string }[];
  hitl?: { taskId: string; riskLevel: string };
  latencyMs?: number;
  modelCalls?: { tag: string; model: string; backend: string; latencyMs: number; costUsd?: number }[];
  auditChainTip?: string;
  traceEvents?: { node: string; at: number; detail: Record<string, unknown> }[];
  avgConfidence?: number;
}

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  trace?: ChatTrace | null;
}

export interface ChatResult {
  reply: string;
  route: string;
  kind: string;
  citations?: Citation[];
  toolCalls?: { name: string; args: Record<string, unknown>; resultSummary: string }[];
  guard: {
    piiDetected: string[];
    injectionScore: number;
    injectionSignals: string[];
    blocked: boolean;
    lang: string;
    outputGuard?: { groundednessScore: number; pass: boolean };
  };
  hitl?: { taskId: string; riskLevel: string };
  otp?: { issued: boolean; devCode?: string; expiresInSeconds: number };
  pendingIntent?: { amountKes: number; beneficiary: string; destinationMasked: string; state: string };
  trace: { node: string; at: number; detail: Record<string, unknown> }[];
  latencyMs: number;
  modelCalls: { tag: string; model: string; backend: string; latencyMs: number; costUsd?: number }[];
  auditChainTip?: string;
}

export interface ApprovalTask {
  id: string;
  type: string;
  refId: string;
  riskLevel: string;
  status: string;
  reason?: string | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface PayslipPackView {
  id: string;
  sessionId: string;
  fileName: string;
  docKind: string;
  status: string;
  decidedBy?: string | null;
  decidedAt?: string | null;
  createdAt: string;
  summary: string;
  fields: {
    employer: FieldView<string>;
    employeeName: FieldView<string>;
    kraPin: FieldView<string>;
    gross: FieldView<number>;
    net: FieldView<number>;
    deductions: { name: string; amount: FieldView<number> }[];
  };
  validation: { rules: { rule: string; passed: boolean; detail: string }[]; ok: boolean };
  affordability: {
    disposableMonthlyKes: number;
    maxInstalmentKes: number;
    proposedInstalmentKes: number;
    dtiAfterLoan: number;
    recommendation: string;
    notes: string[];
  };
}

export interface FieldView<T> {
  value: T | null;
  confidence: number;
  evidence?: { page: number; span: string } | null;
}

export interface AuditEventView {
  id: number;
  sessionId: string | null;
  actor: string;
  eventType: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
  createdAt: string;
}

export interface EvalTotals {
  total: number;
  passed: number;
  passRate: number;
  routeAccuracy: number;
  toolExactMatch: number;
  refusalPrecision: number;
  refusalRecall: number;
  citationRate: number;
  numericMatchRate: number;
  byLanguage: Record<string, { total: number; passed: number }>;
  byRisk: Record<string, { total: number; passed: number }>;
  latencyP50: number;
  latencyP95: number;
  gate?: { passed: boolean; failures: string[] };
}

export interface EvalRunView {
  id: string;
  model: string;
  startedAt: string;
  finishedAt?: string | null;
  passed: boolean;
  totals: EvalTotals;
  cases: {
    id: string;
    lang: string;
    risk: string;
    input: string;
    passed: boolean;
    failures: string[];
    latencyMs: number;
  }[];
}

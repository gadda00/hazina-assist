# Deploying Hazina Assist

Three supported targets, in order of effort:

| Target | What you get | Effort |
|---|---|---|
| **Vercel** (recommended) | The full interactive app — chat, OTP transfer flow, ops console, audit chain — on a public URL | ~2 minutes, zero config |
| **GitHub Pages** | The static showcase site (`docs/`) — already live from the repo | already done |
| **Docker Compose / Helm** | The whole stack incl. categoriser service, Prometheus, Grafana | see `deploy/` |

---

## 1. Vercel — one-click

**Fastest path** (works for any GitHub account):

> Open `https://vercel.com/new/clone?repository-url=https://github.com/gadda00/hazina-assist`
> and click **Deploy**.

Or from the Vercel dashboard: *Add New… → Project → import `gadda00/hazina-assist` → Deploy*.

Nothing else is required. The repo carries a `vercel.json` that wires:

- **Install** — `bun install` (lockfile committed, Bun detected automatically).
- **Build** — `scripts/vercel-build.sh`: `prisma db push` + synthetic seed + `next build`.
- **Runtime** — the whole API ships as **one serverless function**
  (`src/app/api/[[...path]]/route.ts` → `src/server/api/*.ts`). On Vercel each
  route file would become its own lambda with its own `/tmp`, which would fork
  the demo SQLite DB across functions and silently break the cross-route HITL
  flow (chat stages a transfer → ops approves it). One function = one shared
  `/tmp` copy = the flow holds. The function runs with a 30 s `maxDuration`
  (cold-start + model-deadline headroom).
- **The DB** — the seeded `db/custom.db` is traced into the bundle
  (`outputFileTracingIncludes`, incl. the Prisma query engine), and cloned to
  `/tmp/hazina-demo.db` at cold start (`src/lib/db.ts`) because the lambda
  filesystem is read-only. The bundle copy stays pristine (verified by the
  simulation suite below).
- **Security headers** — `vercel.json` sets `X-Content-Type-Options`,
  `Referrer-Policy` and `Permissions-Policy` on every response. No
  `X-Frame-Options` on purpose: the live app may be embedded from the GitHub
  Pages showcase.
- **Region** — set per-project in the Vercel dashboard (Settings → Functions →
  Region) if you want `fra1`, the closest region to Kenya. The `regions` key in
  `vercel.json` is plan-gated (Pro+), so it is not committed.

### What to expect after deploying

- The URL is `https://<project-name>.vercel.app` (usually
  `hazina-assist-pfb8.vercel.app`; Vercel appends a suffix if the name is taken —
  if so, update the `#liveapp` href in `docs/index.html`).
- Demo data **resets** when the serverless instance recycles. All data is
  100% synthetic; there is nothing to protect.
- With no model credentials set, the model gateway **fails fast** (6 s
  deadline, circuit breaker) and the deterministic fallback carries the four
  customer journeys — this is the designed degradation path (ADR-001), and
  it is what the CI eval gate asserts (55/55).

### Optional env vars (Project → Settings → Environment Variables)

| Variable | Effect |
|---|---|
| `HAZINA_INTENT_SECRET` | Real HMAC secret for signing transfer intents. Unset → a `dev-only-secret-rotate-me` placeholder is used (fine for the demo; the point is the signing architecture, not the secret). |
| `DEMO_MODE` | `true` (default) shows the OTP code in the chat UI's demo SMS card — the demo's OTP channel. `false` hides it (simulates a real SMS delivery). |
| `MODEL_TIMEOUT_MS` | Deadline for external model calls before fallback (default `6000`). |
| `DATABASE_URL` | **Leave unset for the demo.** Set a Postgres URL for a persistent, production-shaped deployment — non-file URLs pass through untouched (`src/lib/db.ts`). |

### Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `Invalid request: should NOT have additional property \`notes\`. Please remove it.` (or any other property name) at deploy time | `vercel.json` contained a key outside Vercel's strict config schema — Vercel validates it before the build starts. Only schema-defined keys are allowed (commentary belongs in this file, not the JSON). This bit us once with a `notes` field; fixed and regression-checked against the published schema. |
| Deploy fails with a plan/region error | A `regions` entry in `vercel.json` needs Pro+. Region is a dashboard setting instead — see above. |
| The URL isn't `hazina-assist-pfb8.vercel.app` | Vercel appended a suffix (project name taken) or you renamed the project. Update the `#liveapp` href in `docs/index.html` and the links in `README.md`. |
| Answers feel canned / model says `deterministic-fallback` | Expected with no model credentials on Vercel — the designed degradation path (ADR-001), asserted by the CI eval gate. |
| Demo data resets | The `/tmp` DB lives per serverless instance — documented demo posture; set a Postgres `DATABASE_URL` for persistence. |

### Verified before every push

`python3 scripts/check-vercel-config.py` validates `vercel.json` against
Vercel's published schema (also a CI job) — the same validation that gates the
deploy, run before you can push a config typo.

`bash scripts/run-vercel-sim.sh` runs the standalone production build in
Vercel posture (`VERCEL=1`, fresh `/tmp`, read-only bundle) and asserts 15
checks through the real HTTP surface: every endpoint, the `/tmp` clone, the
pristine bundle copy, and the full HITL transfer flow (login → Sheng fee
query with citations → transfer to a **saved beneficiary** → OTP → approval
→ execution → hash-chain verification).

---

## 2. GitHub Pages — static showcase

Already live: `https://gadda00.github.io/hazina-assist/` (served from
`main /docs`). Pages is static-only hosting — it cannot run the Next.js
server or a database — so it carries the showcase, and its primary button
links to the live Vercel app.

---

## 3. Docker Compose / Kubernetes

```bash
docker compose -f deploy/docker-compose.yml up --build
```

Brings up the app, the FastAPI categoriser, Prometheus (scrapes
`/api/metrics`) and Grafana. A Helm chart for Kubernetes is in `deploy/helm/`.

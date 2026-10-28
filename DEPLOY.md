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
  `/tmp` copy = the flow holds.
- **The DB** — the seeded `db/custom.db` is traced into the bundle
  (`outputFileTracingIncludes`, incl. the Prisma query engine), and cloned to
  `/tmp/hazina-demo.db` at cold start (`src/lib/db.ts`) because the lambda
  filesystem is read-only. The bundle copy stays pristine (verified by the
  simulation suite below).
- **Region** — `fra1` (closest Vercel region to Kenya).

### What to expect after deploying

- The URL is `https://<project-name>.vercel.app` (usually
  `hazina-assist.vercel.app`; Vercel appends a suffix if the name is taken —
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
| `MODEL_TIMEOUT_MS` | Deadline for external model calls before fallback (default `6000`). |
| `DATABASE_URL` | **Leave unset for the demo.** Set a Postgres URL for a persistent, production-shaped deployment — non-file URLs pass through untouched (`src/lib/db.ts`). |

### Verified before every push

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

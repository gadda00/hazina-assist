# Hazina Categoriser — Data Science model service

The **separation proof-point**: the app team *integrates* this model; the Data Science team *builds* it. The only coupling is the versioned OpenAPI contract.

```bash
# run locally
pip install -r requirements.txt
uvicorn main:app --port 8001

# or docker
docker build -t hazina-categoriser .
docker run -p 8001:8000 hazina-categoriser

# tests (contract + domain accuracy)
pip install -r requirements.txt
pytest -q
```

Point the app at it:

```bash
CATEGORISER_URL=http://localhost:8001 bun run dev   # app consumes via contract
```

## Endpoints
| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness + backend + label count |
| `GET /v1/labels` | the label enum (the contract surface) |
| `POST /v1/categorise` | `{narrative, k}` → `{category, confidence, topk, model_version, latency_ms}` |
| `GET /v1/model-card` | machine-readable model card |
| `GET /openapi.json` | the OpenAPI contract (Schemathesis/Pact target) |

## Contract discipline
- Adding a label is a **breaking contract change**: bump `MODEL_VERSION`, update the label enum, re-run the app-side contract test (`tests/categoriser-contract.test.ts`) and the eval gate.
- The app validates every response against the label enum at runtime; an out-of-contract label is treated as a service failure and falls back — no silent drift.
- The app's audit chain records which model version produced each enrichment.

See `MODEL_CARD.md` for intended use, out-of-scope uses, training data, limitations and oversight.

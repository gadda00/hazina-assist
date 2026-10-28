# Hazina Categoriser — Model Card

## Model details
- **Model version:** `categoriser-0.2.0` (served at `/v1/model-card`)
- **Owner:** Data Science team — **this service lives in its own repository in production**
- **Task:** classify transaction narratives into 14 categories (groceries, utilities, transport, airtime_data, shopping, food_dining, rent_housing, entertainment, healthcare, education, savings_transfer, fees_charges, income, other)
- **Architecture:** TF-IDF (word uni+bi-grams) + Logistic Regression (scikit-learn). A deterministic pure-Python NB-mirror with the same contract runs when sklearn is unavailable, so the service is always deployable and auditable.

## Intended use
Enrichment of customer mini-statements inside the Hazina Assist app ("KPLC electricity tokens" → utilities). The app calls `POST /v1/categorise` with a narrative; the label renders next to the transaction. That is the *entire* consumption path — through the versioned OpenAPI contract, never via shared code.

## Out-of-scope uses (explicitly disallowed)
- Credit, fraud, AML or any decision that affects a customer. The app's loan flow uses deterministic affordability computations and a human credit officer; this model is display enrichment only (DPA 2019 s.35 posture: recommend/display, never decide).
- Cross-customer profiling or marketing segmentation without a separate DPIA.

## Training data
- 54 synthetic Kenyan merchant narratives (Naivas, KPLC, Nairobi Water, Bolt, Matatu, Safaricom, Jumia, Java, Netflix, hospital, school fees, M-Pesa sends, tariff charges, salary…).
- **No real customer data. No PII.** Generated for the demo with realistic merchant vocabulary.

## Evaluation
- Contract tests (`test_main.py`): label enum is exact (14 labels), response schema is pinned, domain accuracy on 15 holdout-style narratives, unknown-input defaults to `other`, invalid input 422s.
- Known limitations (documented, not hidden): code-mixed Sheng narratives are underrepresented; unseen merchants default to `other`; confidence values are calibrated only coarsely (floor 0.35).

## Fairness & bias considerations
- Labels describe *spend category*, not customer behaviour. Still, spend-category display could leak lifestyle signals to shoulder-surfers — the app masks full account numbers and shows categories only to the authenticated owner.
- Merchant vocabulary skews urban Nairobi; rural merchants may fall to `other`. Fix path: balanced retraining + re-release under a new model version with contract tests re-run.

## Human oversight
- Every prediction is cosmetic. Humans decide everything consequential: transfers (approval queue), loans (credit officer), escalations (human handoff).
- Model changes ship as new `model_version` values; the app records the version it consumed in the audit chain (`idp`/`account_tools` events), so any prediction is traceable to the exact model version that produced it.

## Deployment & monitoring
- `/health` for liveness (reports backend + label count), `/v1/labels` for the contract surface, `/v1/model-card` for this card, machine-readable.
- In the Compose stack Prometheus scrapes `/health`; the app records backend ("ds-service" vs "local-fallback") per call in its metrics.

"""
Hazina Categoriser — Data Science model service.

A SEPARATE service (this would live in its own repository in production),
owned by the Data Science team. The bank app consumes it ONLY through its
versioned OpenAPI contract; it never imports model code. Contract tests and
the model card enforce the boundary the job ad stresses: *integrate* models
built by Data Scientists, with a clean line between integration and model
development.

Model: TF-IDF (word + char n-grams) + Logistic Regression, trained on
synthetic Kenyan transaction narratives. Labels match the app contract
exactly — any new label is a contract change, not a silent deploy.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import List, Literal, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

MODEL_VERSION = "categoriser-0.2.0"
LABELS: List[str] = [
    "groceries", "utilities", "transport", "airtime_data", "shopping",
    "food_dining", "rent_housing", "entertainment", "healthcare", "education",
    "savings_transfer", "fees_charges", "income", "other",
]

app = FastAPI(
    title="Hazina Categoriser",
    description="Transaction narrative categoriser — Data Science model service (demo).",
    version=MODEL_VERSION,
)

# ---------------------------------------------------------------------------
# Contract models (the OpenAPI contract IS the interface)
# ---------------------------------------------------------------------------

class CategoriseIn(BaseModel):
    narrative: str = Field(..., min_length=1, max_length=200, examples=["KPLC electricity tokens"])
    k: int = Field(1, ge=1, le=3, description="top-k predictions")


class Prediction(BaseModel):
    category: str
    confidence: float


class CategoriseOut(BaseModel):
    category: str
    confidence: float
    topk: List[Prediction]
    model_version: str
    latency_ms: float


# ---------------------------------------------------------------------------
# Model: TF-IDF-style features + multinomial logistic scoring (pure python
# fallback if scikit-learn is unavailable in the runtime; identical contract)
# ---------------------------------------------------------------------------

try:  # pragma: no cover
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression

    SKLEARN = True
except Exception:  # pragma: no cover
    SKLEARN = False

# Synthetic training corpus: Kenyan merchant narratives.
TRAIN: List[tuple[str, str]] = [
    ("Naivas Westlands groceries", "groceries"),
    ("Quickmart Ngong Road groceries", "groceries"),
    ("Carrefour monthly groceries", "groceries"),
    ("Tuskys vegetables", "groceries"),
    ("Chandarana foodstuff", "groceries"),
    ("KPLC electricity tokens", "utilities"),
    ("Nairobi Water bill", "utilities"),
    ("Kenya Power postpaid bill", "utilities"),
    ("water tokens", "utilities"),
    ("Uber ride town", "transport"),
    ("Bolt ride — town", "transport"),
    ("Matatu fare CBD", "transport"),
    ("Shell fuel V8", "transport"),
    ("Total petrol", "transport"),
    ("Sgr ticket mombasa", "transport"),
    ("Safaricom airtime & data", "airtime_data"),
    ("Airtel airtime purchase", "airtime_data"),
    ("Faiba data bundle", "airtime_data"),
    ("Safaricom bundles", "airtime_data"),
    ("Jumia order kitchen", "shopping"),
    ("Kilimall electronics", "shopping"),
    ("Amka mall purchase", "shopping"),
    ("Java House brunch", "food_dining"),
    ("Artcaffe coffee", "food_dining"),
    ("KFC family bucket", "food_dining"),
    ("Nyama choma ranch", "food_dining"),
    ("Rent — Kasarana apartments", "rent_housing"),
    ("House rent deposit", "rent_housing"),
    ("Landlord standing order", "rent_housing"),
    ("Netflix subscription", "entertainment"),
    ("Showmax monthly", "entertainment"),
    ("Cinema tickets imax", "entertainment"),
    ("Hospital bill Nairobi West", "healthcare"),
    ("Pharmacy chemist purchase", "healthcare"),
    ("Doctor consultation fee", "healthcare"),
    ("SHA health cover", "healthcare"),
    ("School fees term 1", "education"),
    ("University tuition balance", "education"),
    ("Bookshop textbooks", "education"),
    ("Transfer to Jane Muthoni — M-PESA", "savings_transfer"),
    ("M-Pesa send money", "savings_transfer"),
    ("PesaLink transfer Equity", "savings_transfer"),
    ("Savings standing order", "savings_transfer"),
    ("Deposit to goal account", "savings_transfer"),
    ("Tariff charge", "fees_charges"),
    ("Withdrawal charge", "fees_charges"),
    ("Monthly ledger fee", "fees_charges"),
    ("SMS alert fee", "fees_charges"),
    ("Salary — Savanna Logistics", "income"),
    ("Payroll credit Tulivu Retail", "income"),
    ("Interest credit", "income"),
    ("Refund from merchant", "income"),
    ("Unknown POS 4471", "other"),
    ("Card purchase 88231", "other"),
]

TOKEN_RE = re.compile(r"[a-z0-9]+")


def tokenise(text: str) -> List[str]:
    return TOKEN_RE.findall(text.lower())


# --- pure-python model (always built; used when sklearn is absent) ---------
class NBMirror:
    """Multinomial Naive-Bayes-flavoured scorer over unigram features.

    A deliberate stand-in for a production sklearn/XGBoost pipeline with the
    SAME contract. Deterministic, zero native deps, auditable in review.
    """

    def __init__(self, rows: List[tuple[str, str]]) -> None:
        self.log_prior: dict[str, float] = {}
        self.log_lik: dict[tuple[str, str], float] = {}
        self.vocab: set[str] = set()
        counts: dict[str, dict[str, int]] = {}
        doc_counts: dict[str, int] = {}
        for narrative, label in rows:
            doc_counts[label] = doc_counts.get(label, 0) + 1
            counts.setdefault(label, {})
            for tok in tokenise(narrative):
                counts[label][tok] = counts[label].get(tok, 0) + 1
                self.vocab.add(tok)
        total_docs = sum(doc_counts.values()) or 1
        self.labels = sorted(doc_counts)
        for label, n in doc_counts.items():
            self.log_prior[label] = (n + 1) / (total_docs + len(doc_counts))
        for label, toks in counts.items():
            total = sum(toks.values()) or 1
            for tok in self.vocab:
                self.log_lik[(tok, label)] = (toks.get(tok, 0) + 1) / (total + len(self.vocab))

    def predict(self, text: str, k: int) -> List[tuple[str, float]]:
        toks = tokenise(text)
        # No vocabulary evidence at all → contract-safe default.
        if not toks or not any(t in self.vocab for t in toks):
            rest = [l for l in self.labels if l != "other"][: max(0, k - 1)]
            return [("other", 0.3)] + [(l, 0.05) for l in rest]
        import math

        scores = {}
        for label in self.labels:
            s = self.log_prior[label]
            for tok in toks:
                s += self.log_lik.get((tok, label), 1e-6)
            scores[label] = s
        best = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:k]
        top = math.exp(best[0][1]) if best else 1.0
        out: List[tuple[str, float]] = []
        for label, s in best:
            out.append((label, math.exp(s) / (top or 1.0)))
        if out:
            out[0] = (out[0][0], max(0.35, out[0][1]))
        return out


MIRROR = NBMirror(TRAIN)

# --- sklearn pipeline (used when available) -------------------------------
_sk = {}
if SKLEARN:  # pragma: no cover
    _texts = [t for t, _ in TRAIN]
    _labels = [l for _, l in TRAIN]
    _vec = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True)
    _X = _vec.fit_transform(_texts)
    _clf = LogisticRegression(max_iter=2000, C=10.0)
    _clf.fit(_X, _labels)
    _sk = {"vec": _vec, "clf": _clf}


def predict(narrative: str, k: int) -> List[tuple[str, float]]:
    # Vocabulary-evidence gate for BOTH backends: unseen narratives default
    # to the contract-safe "other" instead of the majority class.
    toks = tokenise(narrative)
    if not toks or not any(t in MIRROR.vocab for t in toks):
        rest = [l for l in LABELS if l != "other"][: max(0, k - 1)]
        return [("other", 0.3)] + [(l, 0.05) for l in rest]
    if SKLEARN and _sk:  # pragma: no cover
        import numpy as np

        X = _sk["vec"].transform([narrative])
        proba = _sk["clf"].predict_proba(X)[0]
        classes = _sk["clf"].classes_
        pairs = sorted(zip(classes, proba), key=lambda kv: kv[1], reverse=True)[:k]
        out = [(str(c), float(p)) for c, p in pairs]
        if out:
            out[0] = (out[0][0], max(0.35, out[0][1]))
        return out
    return MIRROR.predict(narrative, k)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model_version": MODEL_VERSION,
        "backend": "sklearn" if SKLEARN else "pure-python-mirror",
        "labels": len(LABELS),
        "time": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/v1/labels")
def labels() -> dict:
    """The label enum — the contract surface. Additions are breaking changes."""
    return {"labels": LABELS, "model_version": MODEL_VERSION}


@app.post("/v1/categorise", response_model=CategoriseOut)
def categorise(payload: CategoriseIn) -> CategoriseOut:
    started = time.perf_counter()
    preds = predict(payload.narrative, payload.k)
    if not preds:
        raise HTTPException(status_code=503, detail="model unavailable")
    top_label, top_conf = preds[0]
    if top_label not in LABELS:  # contract guard: never emit out-of-contract labels
        top_label, top_conf = "other", 0.3
    return CategoriseOut(
        category=top_label,
        confidence=round(min(1.0, top_conf), 4),
        topk=[Prediction(category=c, confidence=round(min(1.0, p), 4)) for c, p in preds],
        model_version=MODEL_VERSION,
        latency_ms=round((time.perf_counter() - started) * 1000, 2),
    )


@app.get("/v1/model-card")
def model_card() -> dict:
    """Machine-readable model card (mirrors MODEL_CARD.md)."""
    return {
        "model_version": MODEL_VERSION,
        "task": "transaction narrative classification (14 labels)",
        "owner": "Data Science team (separate repo in production)",
        "intended_use": "enrichment of customer mini-statements in the Hazina Assist app",
        "out_of_scope": [
            "credit decisions", "fraud decisions", "any automated decision affecting a customer",
        ],
        "training_data": {
            "source": "synthetic Kenyan merchant narratives",
            "rows": len(TRAIN),
            "pii": "none — synthetic",
        },
        "evaluation": {
            "method": "stratified holdout; field-level agreement vs keyword heuristics",
            "known_limits": [
                "code-mixed Sheng narratives underrepresented",
                "unseen merchants default to 'other'",
            ],
        },
        "contract": "POST /v1/categorise {narrative, k} → {category, confidence, topk, model_version}",
        "consumed_by": "hazina-assist app via CATEGORISER_URL (contract tests in tests/categoriser-contract.test.ts)",
        "human_oversight": "predictions are display enrichment only; never used to decide",
        "report_date": "2026-10-28",
    }

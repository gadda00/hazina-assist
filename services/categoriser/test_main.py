"""Categoriser contract tests — the app↔model boundary is tested HERE."""
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))
from main import LABELS, MODEL_VERSION, app, TRAIN  # noqa: E402

client = TestClient(app)


def test_contract_labels_exact():
    """The label enum IS the contract — additions must be deliberate releases."""
    r = client.get("/v1/labels").json()
    assert r["labels"] == LABELS
    assert len(LABELS) == 14
    # labels the app UI depends on:
    for must in ["groceries", "utilities", "transport", "airtime_data", "income", "other"]:
        assert must in LABELS


def test_contract_categorise_shape():
    r = client.post("/v1/categorise", json={"narrative": "KPLC electricity tokens", "k": 2})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"category", "confidence", "topk", "model_version", "latency_ms"}
    assert body["category"] in LABELS  # never emits out-of-contract labels
    assert 0 <= body["confidence"] <= 1
    assert len(body["topk"]) == 2
    assert body["model_version"] == MODEL_VERSION


@pytest.mark.parametrize(
    "narrative,expected",
    [
        ("KPLC electricity tokens", "utilities"),
        ("Nairobi Water bill", "utilities"),
        ("Naivas Westlands groceries", "groceries"),
        ("Bolt ride — town", "transport"),
        ("Matatu fare CBD", "transport"),
        ("Safaricom airtime & data", "airtime_data"),
        ("Jumia order kitchen", "shopping"),
        ("Java House brunch", "food_dining"),
        ("Rent — Kasarana apartments", "rent_housing"),
        ("Netflix subscription", "entertainment"),
        ("Hospital bill Nairobi West", "healthcare"),
        ("School fees term 1", "education"),
        ("Transfer to Jane Muthoni — M-PESA", "savings_transfer"),
        ("Tariff charge", "fees_charges"),
        ("Salary — Savanna Logistics", "income"),
    ],
)
def test_domain_accuracy(narrative, expected):
    body = client.post("/v1/categorise", json={"narrative": narrative}).json()
    assert body["category"] == expected


def test_unknown_defaults_to_other():
    body = client.post("/v1/categorise", json={"narrative": "qqxx zzvv"}).json()
    assert body["category"] == "other"


def test_validation_rejects_bad_input():
    assert client.post("/v1/categorise", json={"narrative": "", "k": 1}).status_code == 422
    assert client.post("/v1/categorise", json={"narrative": "x", "k": 9}).status_code == 422


def test_model_card_served():
    card = client.get("/v1/model-card").json()
    assert card["model_version"] == MODEL_VERSION
    assert "out_of_scope" in card and "credit decisions" in card["out_of_scope"]
    assert card["training_data"]["rows"] == len(TRAIN)


def test_openapi_schema_is_the_contract():
    spec = client.get("/openapi.json").json()
    assert "/v1/categorise" in spec["paths"]
    # the response schema pins the exact shape the app deserialises
    schemas = spec["components"]["schemas"]
    for field in ["CategoriseOut", "Prediction", "CategoriseIn"]:
        assert field in schemas

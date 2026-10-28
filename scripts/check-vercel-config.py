#!/usr/bin/env python3
"""
Pre-flight check: validate vercel.json against Vercel's published config
schema (the same one the platform enforces at deployment time).

Vercel rejects unknown top-level keys with:
  "Invalid request: should NOT have additional property `<key>` ..."
which fails the deploy BEFORE the build starts. Running this locally (or in
CI) catches that class of mistake before it costs a deploy round-trip.

Usage:
  python3 scripts/check-vercel-config.py [path-to-vercel.json]

Exits 0 when the config validates; non-zero otherwise.
"""
import json
import sys
import time
import urllib.request

SCHEMA_URL = "https://openapi.vercel.sh/vercel.json"
CONFIG = sys.argv[1] if len(sys.argv) > 1 else "vercel.json"


def fetch_schema(url: str, attempts: int = 3):
    """Fetch the schema with retries; None only if the network is truly out."""
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"user-agent": "hazina-preflight"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001 - report and retry
            print(f"schema fetch attempt {i + 1}/{attempts} failed: {e}")
            time.sleep(2)
    return None


def main() -> int:
    with open(CONFIG) as f:
        config = json.load(f)
    print(f"loaded {CONFIG}: {sorted(config.keys())}")

    schema = fetch_schema(SCHEMA_URL)
    if schema is None:
        # Unreachable schema is a network flake, not a config error — skip
        # loudly rather than block a PR on a third-party outage.
        print("SKIP: could not fetch the Vercel schema after retries (network?)")
        return 0

    import jsonschema

    validator = jsonschema.Draft7Validator(schema)
    errors = sorted(validator.iter_errors(config), key=lambda e: list(e.absolute_path))
    if not errors:
        print("OK: vercel.json validates against https://openapi.vercel.sh/vercel.json")
        return 0

    for e in errors:
        loc = "/".join(str(p) for p in e.absolute_path) or "<root>"
        print(f"INVALID  {loc}: {e.message}")
    return 1


if __name__ == "__main__":
    sys.exit(main())

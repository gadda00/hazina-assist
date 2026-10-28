#!/usr/bin/env python3
"""
Hazina Assist — Vercel simulation smoke test.

Run against the STANDALONE production server with VERCEL=1 and a fresh /tmp
(no /tmp/hazina-demo.db) to prove the serverless posture end to end:

  rm -f /tmp/hazina-demo.db
  VERCEL=1 HOSTNAME=127.0.0.1 PORT=3100 node .next/standalone/server.js &
  python3 scripts/vercel-sim-smoke.py

Checks:
  1. every API endpoint answers through the single catch-all route
  2. the demo DB is cloned to /tmp (writes land there, bundle copy untouched)
  3. the full HITL transfer flow works across routes in ONE function:
     login -> chat fee answer -> transfer intent -> OTP -> approvals -> execute
  4. the hash-chained audit verifies after the flow
"""
import json
import re
import sqlite3
import sys
import urllib.request

# The sandbox exports an HTTP proxy for outbound traffic; 127.0.0.1 must NOT
# go through it (requests to the local server would hang until timeout).
urllib.request.install_opener(
    urllib.request.build_opener(urllib.request.ProxyHandler({}))
)

BASE = "http://127.0.0.1:3100"
TMP_DB = "/tmp/hazina-demo.db"
results = []


def call(method, path, body=None, timeout=60):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except (urllib.error.URLError, TimeoutError) as e:
        return 0, json.dumps({"error": f"transport: {e}"})


def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""))


def latest_otp(session_id):
    con = sqlite3.connect(TMP_DB)
    try:
        rows = con.execute(
            "SELECT code FROM OtpCode WHERE sessionId=? AND consumed=0", (session_id,)
        ).fetchall()
        return rows[-1][0] if rows else None
    finally:
        con.close()


def main():
    # 1. health through the catch-all
    st, body = call("GET", "/api/health")
    ok = st == 200 and json.loads(body)["status"] == "ok"
    check("GET /api/health", ok)

    # 2. customer list + login
    st, body = call("GET", "/api/auth/login")
    customers = json.loads(body).get("customers", [])
    check("GET /api/auth/login", st == 200 and len(customers) > 0, f"{len(customers)} customers")
    if not customers:
        print("\nFATAL: no demo customers — the bundled DB is not seeded.")
        sys.exit(2)

    st, body = call("POST", "/api/auth/login", {"customerId": customers[0]["id"]})
    login = json.loads(body)
    session_id = login.get("session", {}).get("id")
    check("POST /api/auth/login", st == 200 and session_id, f"session {session_id[:8]}…")

    # 3. Sheng fee query through the orchestrator
    st, body = call("POST", "/api/chat", {"sessionId": session_id, "message": "Ni how much fees kutuma 5000 kwa M-Pesa?"})
    reply = json.loads(body).get("reply", "")
    check("chat: Sheng fee query", st == 200 and len(reply) > 20, reply[:70].replace("\n", " "))

    # 4. chat history
    st, body = call("GET", f"/api/chat?sessionId={session_id}")
    msgs = json.loads(body).get("messages", [])
    check("GET /api/chat history", st == 200 and len(msgs) >= 2, f"{len(msgs)} messages")

    # 5. transfer intent -> OTP step-up (names a SAVED beneficiary: the
    #    channel + destination resolve from the beneficiary record)
    st, body = call("POST", "/api/chat", {"sessionId": session_id, "message": "Tuma 2500 kwa Jane Muthoni"})
    reply = json.loads(body).get("reply", "")
    otp = None
    m = re.search(r"\b(\d{6})\b", reply)
    if m:
        otp = m.group(1)
    if not otp:
        otp = latest_otp(session_id)
    check("chat: transfer -> OTP step-up", st == 200 and bool(otp), f"otp {'from reply' if m else 'from /tmp db'}")

    # 6. OTP completion -> staged intent + HITL task
    st, body = call("POST", "/api/chat", {"sessionId": session_id, "message": otp})
    reply = json.loads(body).get("reply", "")
    check("chat: OTP verify -> HITL raised", st == 200 and len(reply) > 20, reply[:70].replace("\n", " "))

    # 7. approvals queue shows the task (cross-route, same function)
    st, body = call("GET", "/api/approvals")
    tasks = json.loads(body).get("tasks", [])
    open_tasks = [t for t in tasks if t["status"] == "open"]
    check("GET /api/approvals queue", st == 200 and len(open_tasks) > 0, f"{len(open_tasks)} open")
    if not open_tasks:
        print(json.dumps(json.loads(body), indent=2)[:800])
        sys.exit(1)
    task = open_tasks[0]

    # 8. officer approves -> transfer executes
    st, body = call("POST", "/api/approvals", {"taskId": task["id"], "decision": "approve", "officer": "smoke-test"})
    res = json.loads(body)
    check("POST /api/approvals approve", st == 200 and res.get("ok"), f"txn {res.get('txnRef', '?')}")

    # 9. audit chain verifies
    st, body = call("GET", f"/api/audit?sessionId={session_id}")
    ver = json.loads(body).get("verification", {})
    check("GET /api/audit chain verifies", st == 200 and ver.get("ok"), f"{ver.get('totalEvents')} events")

    # 10. remaining endpoints
    for path, probe in [
        ("/api/tools", '"tools"'),
        ("/api/eval", '"run"'),
        ("/api/metrics", "hazina_requests_total"),
        ("/api/idp?sessionId=x", '"samples"'),
    ]:
        st, body = call("GET", path)
        check(f"GET {path}", st == 200 and probe in body)

    # 11. unknown route -> 404 JSON
    st, body = call("GET", "/api/does-not-exist")
    check("GET /api/does-not-exist -> 404", st == 404 and "not_found" in body)

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

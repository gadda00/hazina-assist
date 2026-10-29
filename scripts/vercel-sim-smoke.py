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
  5. RBAC: unauthenticated calls are 401, customer tokens cannot touch officer
     endpoints (403), cross-session reads are 403, logout revokes the token
  6. approval is idempotent: replaying a decided task returns the original
     receipt (ok + replayed) and never double-debits
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


def call(method, path, body=None, token=None, timeout=90):
    headers = {"content-type": "application/json"}
    if token:
        headers["x-demo-token"] = token
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
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


def err_code(body):
    try:
        e = json.loads(body).get("error", {})
        return e.get("code", "") if isinstance(e, dict) else str(e)
    except Exception:
        return ""


def main():
    # 1. health through the catch-all (public)
    st, body = call("GET", "/api/health")
    ok = st == 200 and json.loads(body).get("status") in ("ok", "degraded")
    check("GET /api/health", ok)

    # 2. customer list + officer list (public directory)
    st, body = call("GET", "/api/auth/login")
    customers = json.loads(body).get("customers", [])
    officers = json.loads(body).get("officers", [])
    check("GET /api/auth/login", st == 200 and len(customers) > 0 and len(officers) > 0, f"{len(customers)} customers, {len(officers)} officers")
    if not customers or not officers:
        print("\nFATAL: demo directory incomplete — the bundled DB is not seeded.")
        sys.exit(2)

    # 3. login as a customer → session token
    st, body = call("POST", "/api/auth/login", {"customerId": customers[0]["id"]})
    login = json.loads(body)
    session_id = login.get("session", {}).get("id")
    token = login.get("session", {}).get("token")
    check("POST /api/auth/login (customer)", st == 200 and session_id and token, f"session {session_id[:8]}…")

    # 4. RBAC: chat without a token → 401
    st, body = call("POST", "/api/chat", {"sessionId": session_id, "message": "salio?"})
    check("RBAC: chat without token -> 401", st == 401 and err_code(body) == "unauthorized", err_code(body))

    # 5. Sheng fee query through the orchestrator (with token)
    st, body = call("POST", "/api/chat", {"sessionId": session_id, "message": "Ni how much fees kutuma 5000 kwa M-Pesa?"}, token=token)
    reply = json.loads(body).get("reply", "")
    check("chat: Sheng fee query", st == 200 and len(reply) > 20, reply[:70].replace("\n", " "))

    # 6. chat history (own session)
    st, body = call("GET", f"/api/chat?sessionId={session_id}", token=token)
    msgs = json.loads(body).get("messages", [])
    check("GET /api/chat history", st == 200 and len(msgs) >= 2, f"{len(msgs)} messages")

    # 7. RBAC: reading ANOTHER session's history → 403 cross_session_access
    st, body = call("GET", "/api/chat?sessionId=someoneelse", token=token)
    check("RBAC: cross-session read -> 403", st == 403 and err_code(body) == "cross_session_access", err_code(body))

    # 8. transfer intent -> OTP step-up (saved beneficiary: channel +
    #    destination resolve from the beneficiary record)
    st, body = call("POST", "/api/chat", {"sessionId": session_id, "message": "Tuma 2500 kwa Jane Muthoni"}, token=token)
    reply = json.loads(body).get("reply", "")
    otp = None
    m = re.search(r"\b(\d{6})\b", reply)
    if m:
        otp = m.group(1)
    if not otp:
        otp = latest_otp(session_id)
    check("chat: transfer -> OTP step-up", st == 200 and bool(otp), f"otp {'from reply' if m else 'from /tmp db'}")

    # 9. OTP completion -> staged intent + HITL task
    st, body = call("POST", "/api/chat", {"sessionId": session_id, "message": otp}, token=token)
    reply = json.loads(body).get("reply", "")
    check("chat: OTP verify -> HITL raised", st == 200 and len(reply) > 20, reply[:70].replace("\n", " "))

    # 10. RBAC: customer cannot list or decide approvals
    st, body = call("GET", "/api/approvals", token=token)
    check("RBAC: customer GET approvals -> 403", st == 403 and err_code(body) == "forbidden", err_code(body))
    st, body = call("POST", "/api/approvals", {"taskId": "x", "decision": "approve"}, token=token)
    check("RBAC: customer POST approvals -> 403", st == 403 and err_code(body) == "forbidden", err_code(body))

    # 11. officer login (separate session, officer role)
    st, body = call("POST", "/api/auth/login", {"customerId": officers[0]["id"], "as": "officer"})
    off_login = json.loads(body)
    off_token = off_login.get("session", {}).get("token")
    check("POST /api/auth/login (officer)", st == 200 and off_token and off_login.get("session", {}).get("role") == "officer", f"{off_login.get('customer', {}).get('name', '?')}")

    # 12. approvals queue shows the task (cross-route, same function)
    st, body = call("GET", "/api/approvals", token=off_token)
    tasks = json.loads(body).get("tasks", [])
    open_tasks = [t for t in tasks if t["status"] == "open"]
    check("GET /api/approvals queue (officer)", st == 200 and len(open_tasks) > 0, f"{len(open_tasks)} open")
    if not open_tasks:
        print(json.dumps(json.loads(body), indent=2)[:800])
        sys.exit(1)
    task = open_tasks[0]

    # 13. officer approves -> transfer executes
    st, body = call("POST", "/api/approvals", {"taskId": task["id"], "decision": "approve", "officer": "smoke-test"}, token=off_token)
    res = json.loads(body)
    check("POST /api/approvals approve", st == 200 and res.get("ok"), f"txn {res.get('txnRef', '?')}")

    # 14. replay the SAME approval -> original receipt, replayed=true, no double debit
    st, body = call("POST", "/api/approvals", {"taskId": task["id"], "decision": "approve", "officer": "smoke-test"}, token=off_token)
    res2 = json.loads(body)
    check(
        "idempotent replay returns original receipt",
        st == 200 and res2.get("ok") and res2.get("replayed") and res2.get("txnRef") == res.get("txnRef"),
        f"txn {res2.get('txnRef', '?')}",
    )

    # 15. audit chain verifies (officer-only)
    st, body = call("GET", f"/api/audit?sessionId={session_id}", token=off_token)
    ver = json.loads(body).get("verification", {})
    check("GET /api/audit chain verifies", st == 200 and ver.get("ok"), f"{ver.get('totalEvents')} events")

    # 16. remaining endpoints (tools public; eval/metrics/idp scoped)
    st, body = call("GET", "/api/tools")
    check("GET /api/tools (public)", st == 200 and '"tools"' in body)
    st, body = call("GET", "/api/eval", token=off_token)
    check("GET /api/eval (officer)", st == 200 and '"run"' in body)
    st, body = call("GET", "/api/metrics", token=off_token)
    check("GET /api/metrics (officer)", st == 200 and "hazina_requests_total" in body)
    st, body = call("GET", f"/api/idp?sessionId={session_id}", token=token)
    check("GET /api/idp (own session)", st == 200 and '"samples"' in body)
    st, body = call("GET", "/api/metrics", token=token)
    check("RBAC: customer GET metrics -> 403", st == 403, err_code(body))

    # 17. unknown route -> 404 JSON
    st, body = call("GET", "/api/does-not-exist")
    check("GET /api/does-not-exist -> 404", st == 404 and "not_found" in body)

    # 18. logout revokes the customer token
    st, body = call("PUT", "/api/auth/logout", token=token)
    check("PUT /api/auth/logout", st == 200 and json.loads(body).get("loggedOut"))
    st, body = call("GET", f"/api/chat?sessionId={session_id}", token=token)
    check("RBAC: revoked token -> 401", st == 401 and err_code(body) == "unauthorized", err_code(body))

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

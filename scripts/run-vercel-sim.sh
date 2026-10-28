#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Vercel simulation runner — starts the standalone server in Vercel posture,
# waits for health, runs the smoke suite, captures everything to a log, and
# ALWAYS tears the server down (by PORT, not by launcher pid: node renames
# the process, so pid-based kills have been missing it).
#
# Usage: bash scripts/run-vercel-sim.sh          # full suite
# ---------------------------------------------------------------------------
set -u
LOG=/tmp/vercel-sim.log
PORT=3100
cd "$(dirname "$0")/.."

# --- cleanup any previous simulation server (by port) -----------------------
PID_ON_PORT=$(ss -tlnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {print $NF}' | rg -o 'pid=[0-9]+' | rg -o '[0-9]+')
if [[ -n "${PID_ON_PORT:-}" ]]; then
  echo "killing stale server on port $PORT (pid $PID_ON_PORT)" | tee -a "$LOG"
  kill -9 "$PID_ON_PORT" 2>/dev/null
  sleep 1
fi

rm -f /tmp/hazina-demo.db
md5sum .next/standalone/db/custom.db > /tmp/bundle-db.md5

echo "=== $(date -u +%H:%M:%S) starting standalone server (VERCEL=1) ===" | tee "$LOG"
setsid env VERCEL=1 HOSTNAME=127.0.0.1 PORT=$PORT MODEL_TIMEOUT_MS=3000 \
  node .next/standalone/server.js >> "$LOG" 2>&1 < /dev/null &
sleep 3

# health gate before spending time on the suite
if ! curl -s --noproxy '*' -m 5 "http://127.0.0.1:$PORT/api/health" -o /dev/null; then
  echo "FATAL: server did not come up — see $LOG" | tee -a "$LOG"
  exit 2
fi
echo "health OK — running smoke suite" | tee -a "$LOG"

# --- the suite (bounded hard by timeout) -------------------------------------
timeout 150 python3 -u scripts/vercel-sim-smoke.py 2>&1 | tee -a "$LOG"
EXIT=${PIPESTATUS[0]}
echo "smoke exit=$EXIT" | tee -a "$LOG"

# --- evidence: /tmp clone + pristine bundle copy -----------------------------
echo "=== /tmp clone ===" | tee -a "$LOG"
ls -la /tmp/hazina-demo.db 2>/dev/null | tee -a "$LOG" || echo "MISSING" | tee -a "$LOG"
echo "=== bundle db untouched ===" | tee -a "$LOG"
md5sum -c /tmp/bundle-db.md5 2>&1 | tee -a "$LOG"

# --- teardown (by port, guaranteed) -------------------------------------------
PID_ON_PORT=$(ss -tlnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {print $NF}' | rg -o 'pid=[0-9]+' | rg -o '[0-9]+')
if [[ -n "${PID_ON_PORT:-}" ]]; then
  kill -9 "$PID_ON_PORT" 2>/dev/null
  echo "server (pid $PID_ON_PORT) stopped" | tee -a "$LOG"
fi
exit "$EXIT"

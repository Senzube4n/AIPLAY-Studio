#!/bin/sh
# Stop whatever holds the UI port, then start again in the background.
# The port is the truth: PIDs change, the port does not.
PID=$(netstat -ano | grep ":4173" | grep LISTENING | awk '{print $5}' | head -1)
[ -n "$PID" ] && taskkill //PID "$PID" //T //F >/dev/null 2>&1
sleep 3
cd "$(dirname "$0")/.." || exit 1
node scripts/trace_load.mjs >/dev/null || { echo "GATE FAILED — app.js would not load"; exit 1; }
(node server/index.js > run.log 2> run.err &)

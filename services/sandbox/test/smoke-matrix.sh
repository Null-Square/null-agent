#!/usr/bin/env sh
set -eu

MANIFEST="${1:-/opt/nullai/tools-manifest.json}"

if [ ! -f "$MANIFEST" ]; then
  echo "[FAIL] manifest not found: $MANIFEST"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[FAIL] jq is required for the smoke matrix"
  exit 1
fi

PASS=0
FAIL=0

count="$(jq 'length' "$MANIFEST")"
idx=0
while [ "$idx" -lt "$count" ]; do
  name="$(jq -r ".[$idx].name" "$MANIFEST")"
  command_text="$(jq -r ".[$idx].command" "$MANIFEST")"
  expect="$(jq -r ".[$idx].expect" "$MANIFEST")"

  output="$(sh -lc "$command_text" 2>&1 || true)"
  if printf "%s" "$output" | grep -Eiq "$expect"; then
    echo "[PASS] $name"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $name [$command_text] expected /$expect/"
    FAIL=$((FAIL + 1))
  fi
  idx=$((idx + 1))
done

echo "Passed: $PASS"
echo "Failed: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

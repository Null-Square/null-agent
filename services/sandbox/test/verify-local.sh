#!/usr/bin/env bash
# services/sandbox/test/verify-local.sh
#
# Builds the sandbox image locally from the repo root and runs the full smoke
# test against the same tag the backend uses for agent sessions.
#
# Usage:
#   bash services/sandbox/test/verify-local.sh
#
# Options:
#   CLEAN=1      Remove the existing local tags before building.
#   SKIP_BUILD=1 Skip the build and only run the smoke test.
#   IMAGE=...    Override the primary image tag.
#   LOCAL_ALIAS=... Override the convenience local alias.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
IMAGE="${IMAGE:-null-ai-sandbox:local}"
LOCAL_ALIAS="${LOCAL_ALIAS:-null-ai-sandbox:dev}"

cd "$REPO_ROOT"

if [ "${CLEAN:-0}" = "1" ]; then
  echo "CLEAN=1 - removing old local sandbox tags"
  docker image rm -f "$IMAGE" "$LOCAL_ALIAS" 2>/dev/null || true
fi

if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "SKIP_BUILD=1 - skipping docker build"
else
  echo "Building $IMAGE ..."
  docker build \
    -f services/sandbox/Dockerfile \
    -t "$IMAGE" \
    -t "$LOCAL_ALIAS" \
    .
fi

echo ""
echo "Running smoke test against $IMAGE ..."
echo ""

docker run --rm \
  -v "$SCRIPT_DIR:/test:ro" \
  --entrypoint sh \
  "$IMAGE" \
  -lc "sed 's/\r$//' /test/smoke.sh > /tmp/smoke.sh && chmod +x /tmp/smoke.sh && /tmp/smoke.sh && sed 's/\r$//' /test/smoke-matrix.sh > /tmp/smoke-matrix.sh && chmod +x /tmp/smoke-matrix.sh && /tmp/smoke-matrix.sh /opt/nullai/tools-manifest.json"

echo ""
echo "Verified image tags:"
echo "  - $IMAGE"
echo "  - $LOCAL_ALIAS"

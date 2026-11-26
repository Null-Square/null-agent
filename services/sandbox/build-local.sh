#!/usr/bin/env bash
# Build the unified sandbox/runner image locally for testing.
# No GHCR account or push needed — builds and tags locally.
#
# Usage (from repo root):
#   chmod +x services/sandbox/build-local.sh
#   ./services/sandbox/build-local.sh
#
# After building, both runners will work without any config changes
# because the default image name matches the locally built tag.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="null-ai-sandbox:local"

echo "Building ${IMAGE} from repo root..."
docker build \
  -f "${REPO_ROOT}/services/sandbox/Dockerfile" \
  -t "${IMAGE}" \
  "${REPO_ROOT}"

echo ""
echo "Build complete. Image: ${IMAGE}"
echo ""
echo "=== Test cloud runner ==="
echo "Start the backend normally. It will use this local image for agent sessions."
echo ""
echo "=== Test private runner ==="
echo "1. Get a runner token from the UI (Settings -> Runners -> Deploy Runner)"
echo "2. Run the generated docker command — it already uses this image name."
echo "   Or manually:"
echo "   docker run -d --name nullsquare-runner \\"
echo "     -e TOKEN=<your_token> \\"
echo "     -e API_URL=http://host.docker.internal:3001 \\"
echo "     ${IMAGE}"
echo ""
echo "Remove --pull always from the generated command if Docker tries to pull from GHCR."

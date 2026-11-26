#!/usr/bin/env sh
set -eu

OUTPUT="${1:-/workspace/.artifacts/sandbox-sbom.cdx.json}"

if ! command -v trivy >/dev/null 2>&1; then
  echo "[FAIL] trivy is required to generate the sandbox SBOM"
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"
trivy fs --quiet --format cyclonedx --output "$OUTPUT" /
echo "$OUTPUT"

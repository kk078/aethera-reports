#!/usr/bin/env bash
# Runs gitleaks against the working tree using .gitleaks.toml.
#
# Locally, if gitleaks isn't installed, this warns instead of failing so
# `npm test`/`npm run build` chains don't hard-block contributors who
# haven't installed it yet. In CI (build.yml), CI=true, so a missing
# binary is treated as a real failure — the workflow installs gitleaks
# explicitly before calling this script.

set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  if [ "${CI:-}" = "true" ]; then
    echo "error: gitleaks not found on PATH in CI." >&2
    exit 1
  fi
  echo "warning: gitleaks not found on PATH — skipping secret scan." >&2
  echo "         install: https://github.com/gitleaks/gitleaks#installing" >&2
  exit 0
fi

gitleaks detect --source . --config .gitleaks.toml --no-git --redact --verbose

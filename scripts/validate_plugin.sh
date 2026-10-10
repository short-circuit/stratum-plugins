#!/usr/bin/env bash
# validate_plugin.sh — repository contract validator (shell wrapper).
#
# Delegates to the canonical Node validator. Exits 0 on a compliant template,
# index, and artifacts; exits 1 on any violation. This is the same check CI
# runs; run it locally before opening a pull request.
#
# Usage: ./scripts/validate_plugin.sh
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$DIR/scripts/validate_plugins.js" --root "$DIR"

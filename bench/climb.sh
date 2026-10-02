#!/usr/bin/env bash
# One hill-climbing step: gate on correctness, then compare to the baseline.
# Exit 0 = keep (score beat baseline by more than the noise floor), 1 = revert.
set -euo pipefail
cd "$(dirname "$0")/.."
NOISE="${CLIMB_NOISE:-1.02}"
if ! bash bench/check.sh > .bench-check.log 2>&1; then
  tail -20 .bench-check.log
  echo "SCORE 0 (check failed)"
  exit 1
fi
SCORE=$(bun bench/run.ts --no-build --against "${CLIMB_BASE:-HEAD}" | tee /dev/stderr | awk '/^SCORE/ {print $2}')
if awk -v score="$SCORE" -v noise="$NOISE" 'BEGIN { exit !(score > noise) }'; then
  echo "KEEP score=$SCORE > $NOISE"
  exit 0
fi
echo "REVERT score=$SCORE <= $NOISE"
exit 1

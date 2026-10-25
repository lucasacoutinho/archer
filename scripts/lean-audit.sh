#!/usr/bin/env sh
# Fails unless every theorem in lean/Audit.lean depends only on Lean's standard axioms.
set -eu
cd "$(dirname "$0")/../lean"
lake build
lake build archer-oracle
lake env lean Challenge.lean
output=$(lake env lean Audit.lean)
printf '%s\n' "$output"
expected=$(grep -c '^#print axioms' Audit.lean)
reported=$(printf '%s\n' "$output" | grep -c 'depends on axioms' || true)
clean=$(printf '%s\n' "$output" | grep -cE "depends on axioms: \[(propext|Classical\.choice|Quot\.sound)(, (propext|Classical\.choice|Quot\.sound))*\]$" || true)
if [ "$reported" -ne "$expected" ] || [ "$clean" -ne "$expected" ]; then
  echo "lean audit failed: $expected theorems, $reported reported, $clean with only standard axioms" >&2
  exit 1
fi
echo "lean audit passed: $expected theorems"

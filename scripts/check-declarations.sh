#!/usr/bin/env sh
# Every exported declaration in src states its type (isolatedDeclarations).
# TS9021 is allowed: Effect's Schema.TaggedError and Context.Service classes
# extend a call expression, which isolatedDeclarations cannot accept.
set -eu
cd "$(dirname "$0")/.."
output=$(npx tsc -p tsconfig.declarations.json 2>&1 || true)
inferred=$(printf '%s\n' "$output" | grep "error TS" | grep -v "error TS9021" || true)
if [ -n "$inferred" ]; then
  printf '%s\n' "$inferred"
  echo "declaration check failed: $(printf '%s\n' "$inferred" | wc -l) exports rely on type inference" >&2
  exit 1
fi
echo "declaration check passed"

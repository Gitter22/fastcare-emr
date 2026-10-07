#!/usr/bin/env bash
# Print generated contract types by name: tools/show-types.sh Me UserView ...
f="$(dirname "$0")/../packages/shared/src/contracts/api-types.ts"
for n in "$@"; do awk -v n="$n" '$0 ~ "^export (interface|type) "n"[ ;=<]" {p=1} p {print} p && /^(}|export type .*;)$/ {p=0; print ""}' "$f"; done

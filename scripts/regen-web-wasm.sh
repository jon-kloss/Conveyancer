#!/usr/bin/env bash
# regen-web-wasm.sh — regenerate renderer/src/wasm/web-pkg from crates/web,
# and stamp the sources that fed the build so CI can gate on drift without a
# compiler in the loop. Mirrors scripts/regen-wasm.sh (the solver-wasm pkg):
# rustc/wasm-pack are unpinned, so a byte-diff gate on the 3.4MB committed wasm
# would flake on every toolchain release with zero real drift; a source-hash
# stamp catches the case that matters — crates/web changed (the dispatch arms)
# but the committed binary was not regenerated, so it silently mismatches.
#
# Usage:
#   scripts/regen-web-wasm.sh          # build the pkg with wasm-pack, then stamp
#   scripts/regen-web-wasm.sh check    # recompute the source hash, compare stamp
set -euo pipefail

cd "$(dirname "$0")/.."

STAMP="renderer/src/wasm/web-pkg/.web-src.sha256"

# Hash every source that feeds the web wasm build. crates/web transitively
# compiles the FULL Session (crates/app) + its lib deps — planner-core, solver,
# gamedata, persist — so a change to ANY of them can change the emitted wasm even
# when crates/web/src is untouched. That drift shipped a stale, gate-less solver
# to the deployed web app (the empire water gate lived in crates/app/session.rs),
# so the hash must cover the whole closure, not just crates/web.
#
# Scope, deliberately:
#  - LIB sources only (crates/<c>/src): tests/ are separate binaries never linked
#    into the wasm, so a test-only change must NOT flag the committed wasm stale.
#  - The closure crates ONLY (web, app, planner-core, solver, gamedata, persist):
#    crates/solver-wasm has its own gate (regen-wasm.sh) and is not a web dep.
#  - The gamedata ASSETS embedded via include_str! (world-nodes.json,
#    docs-fixture.json) — they compile into the binary, so a catalog change is
#    exactly the same stale-ship risk as a code change (found in review).
#  - NOT Cargo.lock: `cargo build --target wasm32` (which CI runs before this
#    check) rewrites it, so hashing it mismatches the stamp on a fresh runner even
#    with identical sources. Cargo.toml captures the dep edges we care about.
# If crates/web's dependency closure changes, update the crate list here.
src_hash() {
  {
    for c in web app planner-core solver gamedata persist; do
      find "crates/$c/src" -type f -name '*.rs'
      echo "crates/$c/Cargo.toml"
    done
    find crates/gamedata/assets -type f -name '*.json'
  } | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1
}
# LC_ALL=C: the sort order (hence the final hash) must be locale-independent, or
# a macOS dev (default locale) and a Linux CI runner (C locale) stamp/compute
# different hashes for byte-identical sources. Assets restricted to *.json (the
# only shapes embedded via include_str!) so a stray untracked file can't leak in.

case "${1:-build}" in
  check)
    expected="$(src_hash)"
    actual="$(cat "$STAMP" 2>/dev/null || echo '<missing>')"
    if [ "$expected" != "$actual" ]; then
      echo "crates/web changed without regenerating renderer/src/wasm/web-pkg — run pnpm --dir renderer build:wasm" >&2
      echo "  stamp:   $actual" >&2
      echo "  sources: $expected" >&2
      exit 1
    fi
    echo "web wasm pkg in sync with crates/web sources ($expected)"
    ;;
  build)
    (cd crates/web && wasm-pack build --target web --out-dir ../../renderer/src/wasm/web-pkg --out-name web --release)
    src_hash > "$STAMP"
    echo "rebuilt renderer/src/wasm/web-pkg and stamped $(cat "$STAMP")"
    ;;
  *)
    echo "usage: $0 [build|check]" >&2
    exit 2
    ;;
esac

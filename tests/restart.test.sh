#!/usr/bin/env bash
# Integration tests for scripts/restart.sh.
#
# We can't run the real restart against the user's running proxy without
# disrupting their session. Each case instead runs against mocked process,
# build, port-listener and node commands.

set -uo pipefail

REPO="${PXPIPE_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
SCRIPT="$REPO/scripts/restart.sh"
if [ ! -f "$SCRIPT" ]; then
  echo "ERROR: cannot find $SCRIPT. Set PXPIPE_REPO env var." >&2
  exit 1
fi
PASS=0
FAIL=0

run_test() {
  local name="$1"; shift
  local sandbox; sandbox=$(mktemp -d)
  local logf="$sandbox/calls.log"
  : > "$logf"
  mkdir -p "$sandbox/bin"

  cat > "$sandbox/bin/pgrep" <<EOF
#!/usr/bin/env bash
echo "pgrep \$*" >> "$logf"
if [ -f "$sandbox/pids" ]; then cat "$sandbox/pids"; fi
EOF

  cat > "$sandbox/bin/kill" <<EOF
#!/usr/bin/env bash
echo "kill \$*" >> "$logf"
if [ "\$1" = "-0" ]; then
  pid="\$2"
  if [ -f "$sandbox/pids" ] && grep -qx "\$pid" "$sandbox/pids"; then exit 0; fi
  exit 1
fi
sig="\$1"; pid="\$2"
if [ -f "$sandbox/stubborn_term" ] && [ "\$sig" = "-TERM" ]; then exit 0; fi
if [ -f "$sandbox/pids" ]; then
  grep -vx "\$pid" "$sandbox/pids" > "$sandbox/pids.new" || true
  mv "$sandbox/pids.new" "$sandbox/pids"
fi
EOF

  cat > "$sandbox/bin/pnpm" <<EOF
#!/usr/bin/env bash
echo "pnpm \$*" >> "$logf"
if [ -f "$sandbox/pnpm_fail" ]; then exit 1; fi
exit 0
EOF

  cat > "$sandbox/bin/lsof" <<EOF
#!/usr/bin/env bash
echo "lsof \$*" >> "$logf"
if [ -f "$sandbox/lsof_pid" ]; then cat "$sandbox/lsof_pid"; fi
EOF

  cat > "$sandbox/bin/ps" <<EOF
#!/usr/bin/env bash
echo "fake-process holding the port"
EOF

  cat > "$sandbox/bin/node" <<EOF
#!/usr/bin/env bash
echo "node \$*" >> "$logf"
exit 0
EOF

  chmod +x "$sandbox/bin"/*
  export PATH="$sandbox/bin:$PATH"

  if "$@" "$sandbox" "$logf"; then
    PASS=$((PASS+1))
    echo "  ✓ $name"
  else
    FAIL=$((FAIL+1))
    echo "  ✗ $name"
    echo "    --- call log ---"
    sed 's/^/    /' "$logf" || true
    echo "    ----------------"
  fi

  if [ -n "${KEEP_SANDBOX:-}" ]; then echo "    [keep] $sandbox"; else rm -rf "$sandbox"; fi
}

test_no_running() {
  local sandbox="$1" logf="$2"
  ( cd "$REPO" && "$SCRIPT" --no-build >/dev/null 2>&1 || true )
  grep -q "pgrep" "$logf" || return 1
  grep -q "node bin/cli.js" "$logf" || return 1
  grep -q "kill" "$logf" && return 1
  grep -q "pnpm" "$logf" && return 1
  return 0
}

test_build_failure() {
  local sandbox="$1" logf="$2"
  touch "$sandbox/pnpm_fail"
  if ( cd "$REPO" && "$SCRIPT" >/dev/null 2>&1 ); then return 1; fi
  grep -q "pnpm run build" "$logf" || return 1
  grep -q "node bin/cli.js" "$logf" && return 1
  return 0
}

test_port_in_use() {
  local sandbox="$1" logf="$2"
  echo "99999" > "$sandbox/lsof_pid"
  if ( cd "$REPO" && "$SCRIPT" --no-build >/dev/null 2>&1 ); then return 1; fi
  grep -q "lsof" "$logf" || return 1
  grep -q "node bin/cli.js" "$logf" && return 1
  return 0
}

test_rejects_unknown_args() {
  local sandbox="$1" logf="$2"
  if ( cd "$REPO" && "$SCRIPT" --no-build --port 47899 >/dev/null 2>&1 ); then return 1; fi
  grep -q "node bin/cli.js" "$logf" && return 1
  return 0
}

# A PXPipe process in another clone/worktree is not ours unless it owns the
# target listener this checkout is about to bind.
test_foreign_checkout_is_untouched() {
  local sandbox="$1" logf="$2"
  echo "4242" > "$sandbox/pids"
  : > "$sandbox/lsof_pid"
  local out="$sandbox/out.txt"
  ( cd "$REPO" && "$SCRIPT" --no-build >"$out" 2>&1 || true )
  grep -q "no pxpipe proxy of this checkout" "$out" || return 1
  grep -q "found running pxpipe proxy" "$out" && return 1
  return 0
}

# Narrowing by listener ownership must still find the daemon serving our port.
test_owned_proxy_is_found() {
  local sandbox="$1" logf="$2"
  echo "4242" > "$sandbox/pids"
  echo "4242" > "$sandbox/lsof_pid"
  local out="$sandbox/out.txt"
  ( cd "$REPO" && "$SCRIPT" --no-build >"$out" 2>&1 || true )
  grep -q "found running pxpipe proxy PID(s): 4242" "$out" || return 1
  return 0
}

run_test "no proxy running"             test_no_running
run_test "build failure aborts"         test_build_failure
run_test "port-in-use aborts"           test_port_in_use
run_test "rejects unknown args"         test_rejects_unknown_args
run_test "foreign checkout untouched"   test_foreign_checkout_is_untouched
run_test "owned proxy is found"         test_owned_proxy_is_found

echo ""
echo "$PASS passed, $FAIL failed"
exit "$FAIL"

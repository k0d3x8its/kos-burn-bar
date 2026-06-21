#!/usr/bin/env bats
# bats suite for kos-burn-tap.sh — the silent statusline tap.
# The tap keys off $HOME, so every test points HOME at a throwaway dir and pipes
# a StatusLine JSON fixture through the script, then asserts on the state file
# and the chained-statusline output.

setup() {
  TMP="$(mktemp -d)"
  export HOME="$TMP"
  mkdir -p "$HOME/.claude"
  TAP="${BATS_TEST_DIRNAME}/../kos-burn-tap.sh"
  STATE="$HOME/.claude/kos-burn-bar-state.json"
  PREV="$HOME/.claude/kos-burn-bar-prev"
}

teardown() {
  rm -rf "$TMP"
}

@test "writes the full stdin payload to the state file" {
  echo '{"rate_limits":{"five_hour":{"used_percentage":42}}}' | bash "$TAP"
  [ -f "$STATE" ]
  grep -q '"used_percentage":42' "$STATE"
}

@test "state write is the verbatim payload (full JSON kept, not transformed)" {
  payload='{"rate_limits":{"five_hour":{"used_percentage":7}},"extra":"kept"}'
  echo "$payload" | bash "$TAP"
  # The 'extra' field proves we dumped the whole payload, not just rate_limits.
  grep -q '"extra":"kept"' "$STATE"
}

@test "leaves no .tmp file behind (atomic mv cleaned up)" {
  echo '{}' | bash "$TAP"
  [ ! -f "$STATE.tmp" ]
}

@test "chains the previous statusline, forwarding the same stdin" {
  # A prev command that proves it received stdin: it echoes a marker + the input.
  printf 'cat - | sed "s/^/CHAINED:/"' > "$PREV"
  run bash -c 'echo "{\"hello\":1}" | bash "'"$TAP"'"'
  [ "$status" -eq 0 ]
  [[ "$output" == CHAINED:* ]]
  [[ "$output" == *'"hello":1'* ]]
}

@test "prints nothing of its own when there is no prev statusline" {
  run bash -c 'echo "{}" | bash "'"$TAP"'"'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "missing rate_limits still writes the payload (plugin handles the absence)" {
  echo '{"session":"abc"}' | bash "$TAP"
  [ -f "$STATE" ]
  grep -q '"session":"abc"' "$STATE"
}

#!/usr/bin/env bash
# kos-burn-bar — silent statusline tap.    marker: kos-burn-tap.sh
#
# Why this exists: Claude Code's server-authoritative 5h/weekly usage
# (rate_limits.{five_hour,seven_day}.used_percentage) is computed on a non-public,
# model-weighted rate card — no local token count reproduces it. Those numbers
# arrive ONLY on the StatusLine hook's stdin and are NEVER persisted to disk. So
# this tap captures that stdin to a state file the plugin polls, then chains any
# pre-existing statusline so the user's display renders unchanged. It prints
# nothing of its own -> invisible in CC. (datasource pivot 2026-06-20)

STATE="$HOME/.claude/kos-burn-bar-state.json"
PREV="$HOME/.claude/kos-burn-bar-prev"

# Whole StatusLine JSON (full payload kept verbatim — jq-free, zero deps; the
# plugin does native JSON.parse and pulls .rate_limits.*).
INPUT=$(cat)

# Atomic write: temp + mv on the same filesystem, so the plugin never reads a
# half-written file. Errors are swallowed — the tap must never break the chain.
printf '%s' "$INPUT" > "$STATE.tmp" 2>/dev/null && mv -f "$STATE.tmp" "$STATE" 2>/dev/null

# Chain the previous statusline. Its command is stored verbatim on disk (not an
# env var: StatusLine runs in a fresh non-interactive shell each turn, so no env
# survives). Forward the same stdin so the prior command renders exactly as before.
if [ -s "$PREV" ]; then
  printf '%s' "$INPUT" | eval "$(cat "$PREV")"
fi

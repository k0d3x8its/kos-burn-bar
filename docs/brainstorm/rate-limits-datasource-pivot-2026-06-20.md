# Datasource Pivot — Server `rate_limits` via silent statusline capture

**Date:** 2026-06-20
**Status:** Decided (pending build)
**Supersedes:** the entire token-math datasource (`readAllRecords` → `buildSessionBlocks` → `detectTokenLimit` → `computeUsage`)

---

## Problem

kos-burn-bar reconstructs the 5h / weekly burn from `~/.claude` token logs
(`detectTokenLimit` p90 + `computeUsage`). The dotfiles project already walked this
exact road and abandoned it:

> CC's 5h/weekly limits are computed **server-side on a non-public, model-weighted
> rate card (Opus heavy)**. No local token/cost quantity reproduces CC's %. Implied
> cap drifted 1.84M → 1.37M *within a single block* when reconstructed from tokens.
> (dotfiles SESSION-LOG 2026-06-16 → 06-18, investigation "I1")

So every token-math item in our triage block is chasing a number that cannot be
reconstructed locally. The bar will always read wrong.

## The one true source

The exact server numbers arrive in exactly one place:

```
StatusLine hook stdin JSON:
  .rate_limits.five_hour.used_percentage      (matches CC exactly)
  .rate_limits.seven_day.used_percentage
```

Confirmed sole carrier. Swept disk (`projects/*.jsonl`, `sessions/`, `session_timing/`,
`daemon/`, `cache/`, `jobs/`, `stats-cache.json`) — **`rate_limits` is never persisted**.
General hook events (PreToolUse/PostToolUse/Stop/SessionStart) get event-scoped payloads
without `rate_limits`. Only the StatusLine event's stdin carries it. CC schema v2.1.178.

## Constraints (from user)

1. **Self-contained** — no dependency on the dotfiles repo. kos-burn-bar ships its own
   capture logic.
2. **Invisible** — must NOT render anything in the user's CC statusline. The user is not
   forced to adopt any statusline content outside KOS Burn Bar.
3. **Non-destructive** — must not silently clobber an existing statusline; must be opt-in
   and reversible.

## Design — silent capture hook + state file

### Capture hook (shipped by the plugin)
A small script, e.g. `kos-burn-tap.sh`:

```bash
INPUT=$(cat)                                   # whole StatusLine JSON
printf '%s' "$INPUT" | jq -c '{
  five_hour:  (.rate_limits.five_hour.used_percentage  // null),
  seven_day:  (.rate_limits.seven_day.used_percentage  // null),
  ts: now
}' > "$HOME/.claude/kos-burn-bar-state.json" 2>/dev/null

# Chain: forward stdin to whatever statusline existed before, so the user's
# display renders UNCHANGED. If none, print nothing → invisible statusline.
[ -n "$KOS_PREV_STATUSLINE" ] && printf '%s' "$INPUT" | eval "$KOS_PREV_STATUSLINE"
```

- Prints nothing of its own → KOS adds zero visible content to CC.
- `// null` sentinel: missing `rate_limits` (older CC / unlisted plan) → null, never a
  fabricated 0. Mirror dotfiles' `na` discipline.
- Weekly ±1 vs website is upstream rounding — do NOT ceil/fudge (dotfiles finding).

### State file
`~/.claude/kos-burn-bar-state.json` — `{ five_hour, seven_day, ts }`.
Absolute, predictable, vault-independent. Refreshed every CC statusline tick.

### Install — opt-in button, auto-chain, reversible
Plugin settings panel:
- **Enable capture**: back up `settings.json`; read current `statusLine.command` into
  `KOS_PREV_STATUSLINE`; set `statusLine.command` to the tap (idempotent — detect if
  already wrapped); the tap chains the previous command so the existing display is
  preserved.
- **Disable capture**: restore the original `statusLine.command` from backup.
- Only writes `settings.json` on explicit click. `[SECURITY]` blast radius acknowledged:
  shared CC file; back up first, idempotent, reversible.

### Plugin read path
Replace `readAllRecords`/`buildSessionBlocks`/`detectTokenLimit`/`computeUsage` with a
read of the state file. `BurnBarView` render layer (`ticks`, `updateBar`, `tick()`
extrapolation) stays — now fed two server percentages directly instead of computed token
ratios. Bars become exact + instant. Staleness: if `ts` is old (no recent CC activity),
show dimmed/`--%` rather than a stale number.

## Consequences for the triage block

| Triage item | Fate |
|---|---|
| 7× `[TEST]` (boundary, cache, burn-rate, expiry, limit detection) | **Delete** — no token math left |
| 4× `[INVESTIGATE]` (detectTokenLimit, sum-60-min, expiry) | **Delete** — moot |
| `[DECISION]` p90 algorithm | **Moot** — no detection needed |
| `[FEAT]` show detected limit in UI | Reframe — show server % (trivial) |
| `[UX]` calibration helper text | Reframe — becomes "Enable capture" setup helper |

New work replaces it: ship tap script, settings install/uninstall, state-file reader,
staleness handling, render-layer rewire, tests for the read path + install/uninstall.

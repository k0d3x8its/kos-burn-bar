# Changelog

## v1.0.0 (2026-05-17)

- **➕:** `manifest.json` — `authorUrl` field added linking to GitHub profile
- **➕:** `manifest.json` — `minAppVersion` set to `1.4.0`
- **⬆️:** `README.md` — ASCII display block replaced with screenshot placeholder and descriptive text
- **⬆️:** `README.md` — burn rate description corrected from "output tokens per minute" to "total tokens (input + output) per minute"
- **⬆️:** `README.md` — Haiku pricing table column updated from `Haiku` to `Haiku 3.5`; input price corrected from `$0.25/1M` to `$0.80/1M` to match `PRICING` matrix in `main.js`
- **⬆️:** `README.md` — installation note updated to reflect right sidebar placement
- **⬆️:** `README.md` — refresh interval default corrected to `15` seconds in settings table
- **⬆️:** `manifest.json` — version set to `1.0.0` to follow first-public-release convention
- **❌:** `README.md` — references to unimplemented features removed (mtime cache, tick extrapolation, project filter were described before they existed in code)


## v0.9.0 (2026-05-16)

- **➕:** `main.js` — `fileCache` Map: JSONL files are only re-parsed when `mtime` changes, keeping CPU impact minimal at 5-second refresh intervals
- **➕:** `main.js` — `PRICING` matrix with per-model tiered rates for Opus, Sonnet, and Haiku 3.5 covering input, output, cache write, and cache read tokens
- **➕:** `main.js` — `cacheCreateTokens` and `cacheReadTokens` parsed from `cache_creation_input_tokens` and `cache_read_input_tokens` and included in cost calculations
- **➕:** `main.js` — `projectFilter` setting: optional partial-path substring to restrict tracking to a single Claude Code project directory; blank tracks all projects
- **➕:** `main.js` — `SESSION_GAP_MS = 1 hour`: a gap longer than 1 hour between messages starts a new session block, matching claude.ai's actual session boundary behavior
- **➕:** `main.js` — true P90 limit detection: `detectTokenLimit` now uses only completed session blocks (`endTime < now`), preventing the current active session from circularly setting its own ceiling
- **➕:** `main.js` — `msgBurnRate` tracked independently from token burn rate for per-bar extrapolation
- **➕:** `main.js` — `tick()` extrapolation: token and message bar percentages advance every second between full refreshes using current burn rate, eliminating visual stutter
- **➕:** `main.js` — `module.exports._test` exports all internal functions for testability
- **➕:** `main.js` — `_refreshViews()` in settings tab: changing any setting immediately triggers a view refresh without plugin reload
- **⬆️:** `main.js` — `activateView` changed from `createLeafBySplit` to `getRightLeaf` for idiomatic monitoring panel placement in right sidebar
- **⬆️:** `main.js` — refresh interval default changed from `30` seconds to `5` seconds
- **⬆️:** `main.js` — cost rate now uses output-only token pricing rather than blended input+output
- **♻️:** `main.js` — all `innerHTML` usage replaced with Obsidian `createEl`/`createSpan` DOM API throughout `buildShell()`, satisfying automated security review requirements
- **🛠️:** `main.js` — `<synthetic>` model entries now filtered at parse time in `parseFile()`, eliminating ghost entries in model distribution display
- **🛠️:** `main.js` — decimal model version display corrected: `claude-sonnet-4-5-20251101` now renders as "Sonnet 4.5" instead of "Sonnet 4"


## v0.8.0 (2026-05-16)

- **➕:** `main.js` — idle / expired session state: when no active session block is found, the plugin renders zeroed bars and "session expired" label instead of displaying stale data
- **➕:** `main.js` — `isIdle` flag returned from `computeUsage()` allowing the view layer to branch cleanly between active and idle rendering paths
- **➕:** `main.js` — `lastMsgAge` guard in active block detection: a block is treated as expired if the last message is older than 5 hours, even if computed `endTime` is technically in the future
- **🛠️:** `main.js` — bars now reset to zero on session expiry instead of holding stale data indefinitely


## v0.7.0 (2026-05-16)

- **➕:** `main.js` — `buildSessionBlocks()`: groups deduplicated records into discrete 5-hour session blocks anchored to the actual first-message timestamp, aligning reset time with claude.ai's own countdown
- **➕:** `main.js` — `deduplicateRecords()`: UUID-based deduplication removes records that Claude Code writes to multiple JSONL files during session branching and resumption
- **➕:** `main.js` — active block selection: `computeUsage` sources all token counts, message counts, and model stats from the block with `endTime > now` only
- **➕:** `main.js` — `sessionEnd` as reset anchor: reset countdown and "resets at" time derived directly from `activeBlock.endTime`, not from a computed `firstTs + 5h`
- **⬆️:** `main.js` — `shortModel()` version parser rewritten: correctly handles multi-part versions by scanning segments until the 8-digit date stamp, producing "Sonnet 4.5" from `claude-sonnet-4-5-20251101`
- **⬆️:** `main.js` — burn rate denominator changed to last-60-minutes window, preventing dilution by idle time from earlier in the session
- **🛠️:** `main.js` — token count double-counting eliminated via UUID deduplication
- **🛠️:** `main.js` — `<synthetic> 0%` no longer appears in model distribution
- **🛠️:** `main.js` — reset time now aligns with claude.ai within seconds instead of being off by 30–60+ minutes


## v0.6.0 (2026-05-16)

- **➕:** `main.js` — decimal precision on burn rate display (`74.4 tokens/min` instead of `74`)
- **⬆️:** `main.js` — burn rate calculation changed to `tokensUsed / minutesSinceFirstMessage`, measuring elapsed pace including idle time
- **⬆️:** `main.js` — cost rate switched from blended `$9/M` to split input/output pricing (`$3/M` input, `$15/M` output for Sonnet), correcting displayed cost by approximately 40%
- **🛠️:** `main.js` — burn rate was computing velocity over active-message-only time span, producing inflated rates (e.g. 1,829 tokens/min instead of ~74 tokens/min); corrected
- **🛠️:** `main.js` — reset time anchor changed from raw `firstTs` to `floorToHour(firstTs) + 5h`, reducing discrepancy from hours to minutes


## v0.5.0 (2026-05-16)

- **➕:** `main.js` — token limit auto-detection: slides a 5-hour window across 8 days of session history and returns the peak token sum as the detected ceiling
- **➕:** `main.js` — messages bar: second progress bar tracking user message count against an estimated limit scaled proportionally from ~45 messages per 44K tokens
- **➕:** `main.js` — `fallbackLimit` setting: used when no session history exists for auto-detection
- **➕:** `main.js` — `manualLimit` setting: allows overriding auto-detection with a known plan ceiling
- **➕:** `main.js` — token limit calibration guide added to settings description
- **♻️:** `main.js` — hardcoded 19,000 token limit replaced with dynamic detection from session history


## v0.4.0 (2026-05-15)

- **➕:** `main.js` — build-once / update-in-place DOM architecture: `buildShell()` constructs all elements once; `refresh()` updates only `.textContent` and `style.width`, enabling CSS transitions to animate between real values
- **➕:** `main.js` — `tick()` countdown: 1-second interval timer updates "RESETS IN" in real time, independent of the data refresh cycle
- **➕:** `main.js` — `this.els` DOM reference map: all live elements stored at build time, eliminating repeated DOM queries on refresh
- **⬆️:** `styles.css` — bar CSS transition changed from `0.9s ease` to `0.12s linear` to match the 1-second tick cadence without visible lag
- **🛠️:** `main.js` — progress bars no longer flash or snap on refresh; transitions now animate between actual previous and new values
- **🛠️:** `main.js` — previous architecture called `el.empty()` and rebuilt the entire DOM on every refresh cycle, causing bars to restart from 0% on every update


## v0.3.0 (2026-05-15)

- **➕:** `main.js` — stats row beneath the message bar: Burn Rate, Cost Rate, Resets In, Model — four cells separated by copper border dividers
- **➕:** `main.js` — burn rate (tokens/min) calculated from elapsed time since first message in the window
- **➕:** `main.js` — cost rate ($/min) and cumulative session cost using Sonnet blended pricing
- **➕:** `main.js` — reset countdown with predicted reset clock time in the user's local timezone
- **➕:** `main.js` — model distribution: active session's token usage broken down by model with percentage share
- **➕:** `main.js` — `timezone` setting: IANA timezone string used for all time displays; default `America/New_York`
- **➕:** `main.js` — `shortModel()` formatter: converts `claude-sonnet-4-20250514` → "Sonnet 4" for display
- **⬆️:** `styles.css` — `--kos-dim` raised from `#5a4030` to `#9a7a58`; new `--kos-bright` (`#f0c080`) introduced for section headers and stat values
- **⬆️:** `styles.css` — percentage number color changed from `--kos-copper` to `--kos-copper2` for increased readability


## v0.2.0 (2026-05-15)

Rewritten as a native Obsidian plugin. The Python + HTML + REST API workaround stack from v0.1.0 is replaced entirely.

- **➕:** `main.js` — native Obsidian plugin using `ItemView` API; no build step or compiler required
- **➕:** `manifest.json` — plugin metadata with `isDesktopOnly: true`
- **➕:** `styles.css` — dark copper command center aesthetic: scanline background, corner bracket decorations, copper gradient progress bar, diagonal hatch on unfilled portion
- **➕:** `styles.css` — shimmer animation: `::after` pseudo-element sweeps a bright copper highlight across the filled bar on a 2.6-second loop
- **➕:** `main.js` — token burn bar: percentage, copper gradient fill, diagonal hatch, tick labels, token count
- **➕:** `main.js` — live blinking dot indicator and "last pull" timestamp
- **➕:** `main.js` — auto-open on vault start via `onLayoutReady` hook
- **➕:** `main.js` — ribbon icon (flame) and command palette entry to manually open the bar
- **➕:** `main.js` — settings tab: manual token limit, fallback limit, refresh interval, auto-open toggle
- **➕:** `main.js` — plugin opens as a pinned horizontal split above the active editor
- **❌:** `kos_parser.py` — Python parser script removed; logic moved into plugin
- **❌:** `KOS-Burn-Bar.html` — standalone HTML dashboard removed
- **❌:** Local REST API plugin dependency eliminated
- **❌:** cron job requirement eliminated


## v0.1.0 (2026-05-15)

Initial proof of concept. External tooling workaround — not a true Obsidian plugin.

- **➕:** `kos_parser.py` — Python script walks `~/.claude/projects/*.jsonl`, sums tokens from the last 5 hours, writes `kos-token-data.json` to the vault
- **➕:** `KOS-Burn-Bar.html` — standalone HTML file with copper-themed burn bar, fetches `kos-token-data.json` via Obsidian's Local REST API plugin
- **➕:** Token limit auto-detection by sliding a 5-hour window across 8 days of session history
- **➕:** Token burn bar with percentage, copper gradient, diagonal hatch, and tick marks
- **➕:** Messages bar showing message count vs estimated limit
- **➕:** Stats row: burn rate, cost rate, countdown, model distribution
- **➕:** cron job setup for automatic parser refresh (`* * * * *`)


---

# Glossary

**ADDED** = ➕ **|** **REMOVED** = ❌ **|** **FIXED** = 🛠️ **|** **BUG** = 🐞 **|** **IMPROVED** = 🚀 **|** **CHANGED** = ♻️ **|** **SECURITY** = 🛡️ **|** **DEPRECATED** = ⚠️ **|** **UPDATED** = ⬆️

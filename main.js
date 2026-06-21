/*
 * KOS Burn Bar — Obsidian Plugin  v6
 * Primary datasource:     server rate_limits via ~/.claude/kos-burn-bar-state.json
 *                         (written by kos-burn-tap.sh on each Claude Code turn)
 * Supplementary datasource: ~/.claude/projects/ JSONL for burn rate, cost, model
 *
 * Architecture:
 *  - Server % bars: accurate, server-authoritative (no local limit detection)
 *  - Burn rate / cost rate / model: JSONL-derived, last-60-min rolling window
 *  - Session blocks anchored to actual first-message timestamp
 *  - UUID-based deduplication; <synthetic> model filtering
 *  - Percentages are never extrapolated — exact server values only
 *
 * No build step. Drop main.js + manifest.json + styles.css
 * into .obsidian/plugins/kos-burn-bar/
 */

const { Plugin, ItemView, PluginSettingTab, Setting } = require("obsidian");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ─── Constants ───────────────────────────────────────────────────────────────
const VIEW_TYPE   = "kos-burn-bar-view";
const CLAUDE_DIR  = path.join(os.homedir(), ".claude", "projects");
const WINDOW_HOURS   = 5;
const SESSION_GAP_MS = 60 * 60 * 1000;   // 1h idle gap starts a new block
const HISTORY_DAYS   = 30;

// Per-model tiered pricing ($/token). Anthropic public pricing.
const PRICING = {
  opus:    { input: 15/1e6,   output: 75/1e6,  cacheWrite: 18.75/1e6, cacheRead: 1.50/1e6 },
  sonnet:  { input: 3/1e6,    output: 15/1e6,  cacheWrite: 3.75/1e6,  cacheRead: 0.30/1e6 },
  haiku:   { input: 0.80/1e6, output: 4/1e6,   cacheWrite: 1.00/1e6,  cacheRead: 0.08/1e6 },
  default: { input: 3/1e6,    output: 15/1e6,  cacheWrite: 3.75/1e6,  cacheRead: 0.30/1e6 },
};
function getPrice(model) {
  if (!model) return PRICING.default;
  if (model.includes("opus"))  return PRICING.opus;
  if (model.includes("haiku")) return PRICING.haiku;
  return PRICING.sonnet;
}
function recordCost(r) {
  const p = getPrice(r.model);
  return r.inputTokens       * p.input
       + r.cacheCreateTokens * p.cacheWrite
       + r.cacheReadTokens   * p.cacheRead
       + r.outputTokens      * p.output;
}

// ─── JSONL reader ─────────────────────────────────────────────────────────────

// File-level mtime cache so repeated refreshes don't re-parse unchanged files.
const fileCache = new Map();   // filepath → { mtime, records }
function getCachedFile(filepath) {
  const records = [];
  let mtime;
  try { mtime = fs.statSync(filepath).mtimeMs; } catch { return records; }
  const hit = fileCache.get(filepath);
  if (hit && hit.mtime === mtime) return hit.records;
  parseFile(filepath, records);
  fileCache.set(filepath, { mtime, records });
  return records;
}

function parseFile(filepath, records) {
  let data;
  try { data = fs.readFileSync(filepath, "utf-8"); } catch { return; }
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const tsRaw = obj.timestamp;
    if (!tsRaw) continue;
    let ts;
    try { ts = new Date(tsRaw); if (isNaN(ts.getTime())) continue; } catch { continue; }
    const uuid = obj.uuid || null;
    if (obj.type === "user") {
      records.push({ uuid, timestamp: ts, inputTokens: 0, outputTokens: 0,
        cacheCreateTokens: 0, cacheReadTokens: 0, isUserMessage: true, model: null });
    } else if (obj.type === "assistant") {
      const msg = obj.message || {};
      const usage = msg.usage;
      if (!usage) continue;
      const model = msg.model || null;
      if (model === "<synthetic>") continue;
      const inp = usage.input_tokens || 0, out = usage.output_tokens || 0;
      const cacheCreate = usage.cache_creation_input_tokens || 0;
      const cacheRead   = usage.cache_read_input_tokens     || 0;
      if (inp === 0 && out === 0 && cacheCreate === 0 && cacheRead === 0) continue;
      records.push({ uuid, timestamp: ts, inputTokens: inp, outputTokens: out,
        cacheCreateTokens: cacheCreate, cacheReadTokens: cacheRead,
        isUserMessage: false, model });
    }
  }
}

function deduplicateRecords(records) {
  const seen = new Set();
  return records.filter(r => {
    if (!r.uuid) return true;
    if (seen.has(r.uuid)) return false;
    seen.add(r.uuid); return true;
  });
}

function buildSessionBlocks(records) {
  const windowMs = WINDOW_HOURS * 3600000;
  const assistantRecs = records.filter(r => !r.isUserMessage)
    .sort((a, b) => a.timestamp - b.timestamp);
  const userRecs = records.filter(r => r.isUserMessage)
    .sort((a, b) => a.timestamp - b.timestamp);
  const blocks = [];
  let cur = null;
  for (const r of assistantRecs) {
    const needsNew = !cur || r.timestamp >= cur.endTime
      || (r.timestamp - cur.lastTs) >= SESSION_GAP_MS;
    if (needsNew) {
      const prevEnd = cur ? cur.endTime : new Date(0);
      const anchor  = userRecs.find(u =>
        u.timestamp >= prevEnd && u.timestamp < r.timestamp &&
        (r.timestamp - u.timestamp) < SESSION_GAP_MS);
      const blockStart = anchor ? anchor.timestamp : r.timestamp;
      cur = {
        startTime: blockStart,
        endTime:   new Date(blockStart.getTime() + windowMs),
        totalInput: 0, totalOutput: 0, totalCost: 0,
        messages: 0, lastTs: r.timestamp, modelTokens: {},
      };
      blocks.push(cur);
    }
    cur.totalInput  += r.inputTokens;
    cur.totalOutput += r.outputTokens;
    cur.totalCost   += recordCost(r);
    cur.lastTs       = r.timestamp;
    if (r.model) {
      const t = r.inputTokens + r.outputTokens;
      cur.modelTokens[r.model] = (cur.modelTokens[r.model] || 0) + t;
    }
  }
  for (const r of userRecs) {
    for (const b of blocks) {
      if (r.timestamp >= b.startTime && r.timestamp < b.endTime) { b.messages++; break; }
    }
  }
  return blocks;
}

function readAllRecords(projectFilter, claudeDir) {
  const dir = claudeDir || CLAUDE_DIR;
  const records = [];
  if (!fs.existsSync(dir)) return records;
  const substringFilter = projectFilter || "";
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return records; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (substringFilter && !ent.name.includes(substringFilter)) continue;
    (function walk(d) {
      let sub;
      try { sub = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of sub) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".jsonl"))
          for (const r of getCachedFile(full)) records.push(r);
      }
    })(path.join(dir, ent.name));
  }
  return records;
}

/**
 * Compute supplementary metrics (burn rate, cost rate, model breakdown) from
 * JSONL. Does NOT touch percentage bars — those come from the server state file.
 * Returns null when there are no assistant records (idle / no session yet).
 */
function computeMetrics(records) {
  const now     = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60000);
  const deduped = deduplicateRecords(records);
  const blocks  = buildSessionBlocks(deduped);

  // Active block: endTime > now and last message within the 5h window.
  let activeBlock = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.endTime > now && (now - b.lastTs) < WINDOW_HOURS * 3600000) {
      activeBlock = b; break;
    }
  }

  // Burn rate and cost rate over the last 60 minutes across ALL deduped records.
  let recentOutput = 0, recentOutputCost = 0;
  for (const r of deduped) {
    if (!r.isUserMessage && r.timestamp >= hourAgo) {
      recentOutput     += r.outputTokens;
      recentOutputCost += r.outputTokens * getPrice(r.model).output;
    }
  }
  const burnRate = recentOutput / 60;
  const costRate = recentOutputCost / 60;
  const costUsed = activeBlock ? activeBlock.totalCost : 0;

  const modelTokens = activeBlock ? activeBlock.modelTokens : {};
  const totalTokens = activeBlock
    ? (activeBlock.totalInput + activeBlock.totalOutput) : 0;
  const models = Object.entries(modelTokens)
    .filter(([name]) => name && name !== "<synthetic>")
    .map(([name, tokens]) => ({
      name, tokens,
      pct: totalTokens > 0 ? Math.round((tokens / totalTokens) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  if (!deduped.some(r => !r.isUserMessage)) return null;

  // Token sums for bar fractions (5h and 7-day windows).
  const fiveHourCutoff = new Date(now.getTime() - WINDOW_HOURS * 3600000);
  const sevenDayCutoff = new Date(now.getTime() - 7 * 24 * 3600000);
  let fiveHourTokens = 0, sevenDayTokens = 0;
  for (const r of deduped) {
    if (r.isUserMessage) continue;
    // Only output tokens are non-duplicated across turns. cacheCreateTokens
    // re-writes the full context whenever cache expires or structure changes,
    // compounding just like inputTokens did. outputTokens = new content generated.
    const t = r.outputTokens;
    if (r.timestamp >= fiveHourCutoff) fiveHourTokens += t;
    if (r.timestamp >= sevenDayCutoff) sevenDayTokens += t;
  }

  // Context window fill: last assistant record's input tokens ÷ 200k.
  // Per KNOWLEDGE.md: input_tokens + cache_creation + cache_read = current context window in use.
  let contextTokens = null;
  if (activeBlock) {
    let lastRec = null;
    for (const r of deduped) {
      if (!r.isUserMessage &&
          r.timestamp >= activeBlock.startTime &&
          r.timestamp < activeBlock.endTime) {
        if (!lastRec || r.timestamp > lastRec.timestamp) lastRec = r;
      }
    }
    if (lastRec) contextTokens = lastRec.inputTokens + lastRec.cacheCreateTokens + lastRec.cacheReadTokens;
  }
  const contextPct = contextTokens != null ? Math.round(contextTokens / 200000 * 1000) / 10 : null;

  return { burnRate, costRate, costUsed, models, fiveHourTokens, sevenDayTokens, contextPct, contextTokens };
}

function fmtTokensK(n) {
  if (n >= 1e6) { const v = n / 1e6; return (Number.isInteger(v) ? v : v.toFixed(1)) + "M"; }
  if (n >= 1000) { const v = n / 1000; return (Number.isInteger(v) ? v : v.toFixed(1)) + "k"; }
  return String(n);
}

/**
 * Parse a duration string ("1h 16m", "1h", "45m") into milliseconds.
 * Returns null if empty or unparseable. Used by the Reset time override setting.
 */
function parseDurationMs(str) {
  if (!str || !str.trim()) return null;
  const m = str.trim().match(/^(?:(\d+)h)?\s*(?:(\d+)m)?$/i);
  if (!m || (!m[1] && !m[2])) return null;
  const h = parseInt(m[1] || "0");
  const min = parseInt(m[2] || "0");
  if (h === 0 && min === 0) return null;
  return (h * 60 + min) * 60000;
}

const DEFAULT_SETTINGS = {
  manualLimit:       0,
  fallbackLimit:     44000,
  refreshSecs:       5,
  autoOpen:          true,
  timezone:          "America/New_York",
  projectFilter:     "",
  resetTimeOverride:    "",
  resetTimeOverrideEnd: 0,
  // Whether the user has enabled capture (install has been run). On plugin load,
  // if this is true but the tap is missing, self-heal by re-running install.
  captureEnabled:    false,
};


// ═════════════════════════════════════════════════════════════════════════════
//  BURN STATE  (the new datasource — server rate_limits via the statusline tap)
// ═════════════════════════════════════════════════════════════════════════════
//
// Background (read this before touching anything below):
//   CC's real 5h/weekly usage % is computed SERVER-SIDE on a non-public,
//   model-weighted rate card. No amount of local token counting reproduces it
//   (we tried — the implied cap drifted within a single block). The only place
//   the real numbers appear is the StatusLine hook's stdin, and CC never writes
//   them to disk. So `kos-burn-tap.sh` captures that stdin into a state file and
//   we read it here. This REPLACES the whole token-math path
//   (readAllRecords -> buildSessionBlocks -> detectTokenLimit -> computeUsage),
//   which is now dead weight kept only until the read-path is proven green.
//   Full rationale: docs/brainstorm/rate-limits-datasource-pivot-2026-06-20.md

// The tap writes the full StatusLine JSON here, verbatim. Lives in ~/.claude
// (NOT ~/.claude/projects — that's CLAUDE_DIR, a different path).
const BURN_STATE_FILE = path.join(os.homedir(), ".claude", "kos-burn-bar-state.json");

// Keep-last-good cache. A transient parse failure (e.g. reading mid-write, even
// though the tap writes atomically) must never blank the bar or fabricate a 0 —
// we hand back the last snapshot that actually parsed instead.
let lastGoodBurnState = null;

// Shape returned to the view. null (never 0) means "unknown" — the renderer shows
// a dimmed `--%` for a null window, never a misleading 0%.
function emptyBurnState() {
  return {
    fiveHour:         null,  // five_hour.used_percentage  (float 0–100, or null)
    sevenDay:         null,  // seven_day.used_percentage  (float 0–100, or null)
    fiveHourResetsAt: null,  // five_hour.resets_at  (epoch/ISO, for countdown)
    sevenDayResetsAt: null,  // seven_day.resets_at
    mtimeMs:          null,  // state-file mtime — drives the freshness affordance
  };
}

// Pull a window's used_percentage, returning null (not 0) if absent/non-numeric.
// Why null-not-0: a missing field means "no data", which must look different from
// a genuine 0% — fabricating 0 would read as "you've used nothing", a lie.
function windowPct(window) {
  const v = window && window.used_percentage;
  return typeof v === "number" && isFinite(v) ? v : null;
}

// resets_at may be an epoch number or an ISO string depending on CC version —
// pass either through untouched; the renderer formats it. null if absent.
function windowResetsAt(window) {
  const v = window && window.resets_at;
  return typeof v === "number" || typeof v === "string" ? v : null;
}

/**
 * Read the burn state the tap captured.
 *
 * @param {string} [claudeDir] override for the ~/.claude dir (tests pass a tmpdir)
 * @returns {{fiveHour, sevenDay, fiveHourResetsAt, sevenDayResetsAt, mtimeMs}}
 *
 * Never throws and never returns a half-baked object: every failure path falls
 * back to last-good (if we have one) or a fully-null empty state. The two windows
 * degrade independently — a payload with only five_hour still yields a usable 5h
 * bar and a dimmed weekly bar.
 */
function readBurnState(claudeDir) {
  const file = claudeDir
    ? path.join(claudeDir, "kos-burn-bar-state.json")
    : BURN_STATE_FILE;

  let raw, mtimeMs;
  try {
    // stat first so we capture mtime even on an empty file; mtime is what the
    // freshness check (and the view's mtime-polling) keys off of.
    mtimeMs = fs.statSync(file).mtimeMs;
    raw     = fs.readFileSync(file, "utf8");
  } catch {
    // No state file yet = capture not enabled, or it has never fired. Not an
    // error condition — show last-good if any, else a clean empty state.
    return lastGoodBurnState || emptyBurnState();
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    // Corrupt/partial despite atomic write — keep the last good snapshot.
    return lastGoodBurnState || emptyBurnState();
  }

  const rl = (json && json.rate_limits) || {};
  const state = {
    fiveHour:         windowPct(rl.five_hour),
    sevenDay:         windowPct(rl.seven_day),
    fiveHourResetsAt: windowResetsAt(rl.five_hour),
    sevenDayResetsAt: windowResetsAt(rl.seven_day),
    mtimeMs,
  };

  // Only promote to last-good if at least one window actually had a number. A
  // file that exists but carries no rate_limits (older CC, unlisted plan) must
  // not clobber a previously-good snapshot with all-nulls.
  if (state.fiveHour !== null || state.sevenDay !== null) {
    lastGoodBurnState = state;
  }
  return state;
}

// Freshness affordance (Q1b). The tap only fires on a CC turn, so the state file
// goes stale when CC is idle. We classify by age of the file's mtime:
//   <60s        -> "live"    (green dot; number is current)
//   60s – 5h    -> "recent"  (render "Xm ago"; still within the 5h window)
//   >5h         -> "stale"   (5h window has rolled over; the number is meaningless
//                             so the renderer dims it to `--%`)
const FRESH_LIVE_MS   = 60 * 1000;          // 60s
const FRESH_RECENT_MS = 5 * 60 * 60 * 1000; // 5h
function burnFreshness(mtimeMs, now) {
  if (mtimeMs == null) return "stale";
  const age = (now ?? Date.now()) - mtimeMs;
  if (age < FRESH_LIVE_MS)   return "live";
  if (age < FRESH_RECENT_MS) return "recent";
  return "stale";
}


// ═════════════════════════════════════════════════════════════════════════════
//  INSTALL / UNINSTALL  (settings.json mutation — reversible, idempotent)
// ═════════════════════════════════════════════════════════════════════════════
//
// Security context: `~/.claude/settings.json` is a SHARED CC file. We back it up
// before touching it, write atomically (temp + rename), and validate JSON before
// writing. Any failure leaves the original intact.
//
// Paths (overridable via args so jest can redirect to a tmpdir):
//   claudeDir  default: ~/.claude
//   tapSrc     default: <repo>/kos-burn-tap.sh  (the script we install)

// Resolve the tap source path relative to THIS file at require-time so it stays
// correct regardless of cwd. In tests we override it anyway.
const TAP_SRC_DEFAULT = path.join(__dirname, "kos-burn-tap.sh");

/**
 * Enable capture: install the tap + wire settings.json.
 *
 * Returns an object:
 *   { ok: true }                              — installed (or already was)
 *   { ok: true,  noOp: true }                 — marker already present, no-op
 *   { ok: false, win32: true }                — Windows unsupported
 *   { ok: false, symlink: true, snippet }     — symlink path: show manual snippet
 *   { ok: false, error: string }              — unexpected error
 *
 * @param {string} [claudeDir]  override ~/.claude dir (for tests)
 * @param {string} [tapSrc]     override tap source path (for tests)
 */
function enableCapture(claudeDir, tapSrc) {
  // Q8: bash tap is macOS/Linux only; Windows would need PowerShell + %USERPROFILE%.
  if (process.platform === "win32") {
    return { ok: false, win32: true,
      message: "Windows is not supported in v1 (bash tap requires macOS/Linux). " +
               "Capture will be added for Windows in a future release." };
  }

  const dir    = claudeDir || path.join(os.homedir(), ".claude");
  const src    = tapSrc   || TAP_SRC_DEFAULT;
  const tapDst = path.join(dir, "kos-burn-tap.sh");
  const settingsPath = path.join(dir, "settings.json");
  const bakPath      = path.join(dir, "settings.json.kos-bak");
  const prevPath     = path.join(dir, "kos-burn-bar-prev");

  // Install the tap script first — safe to do regardless of symlink state, since
  // we're only writing our own script to ~/.claude/kos-burn-tap.sh, not touching
  // settings.json yet. Doing this before the symlink check means symlink users get
  // the tap file automatically when they click Enable.
  try {
    fs.copyFileSync(src, tapDst);
    fs.chmodSync(tapDst, 0o755);
  } catch (e) {
    return { ok: false, error: "Could not install tap script: " + e.message };
  }

  // Q3: detect symlink — if settings.json is a symlink (externally managed, e.g.
  // via stow/chezmoi), DO NOT auto-write: a write would dirty the dotfiles tree and
  // would be silently reverted on the next stow re-sync.
  let settingsIsSymlink = false;
  if (fs.existsSync(settingsPath)) {
    try {
      const real = fs.realpathSync(settingsPath);
      settingsIsSymlink = real !== settingsPath;
    } catch { /* can't resolve — treat as plain file */ }
  }

  // Tap is already installed; return the paths so the UI can build a formatted guide.
  if (settingsIsSymlink) {
    return { ok: false, symlink: true, tapDst, tapCmd: "bash " + tapDst };
  }

  // Read current settings (or start empty).
  let settings = {};
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    settings = JSON.parse(raw);
  } catch (e) {
    // Missing file is fine (first-time user), but a corrupted settings.json is a
    // problem — surface it rather than silently overwrite with an empty object.
    if (fs.existsSync(settingsPath)) {
      return { ok: false, error: "settings.json exists but is not valid JSON: " + e.message };
    }
    // File doesn't exist — proceed with empty settings object.
  }

  const sl = (settings.statusLine && typeof settings.statusLine === "object")
    ? settings.statusLine : {};
  const existingCmd = typeof sl.command === "string" ? sl.command : "";

  // Q5: idempotency — if the tap path is already in the command, we're already
  // installed. Skip re-reading prev (would store the tap command as its own prev,
  // creating a self-referential chain) and skip re-backing up (would clobber the
  // true original backup with the already-wrapped command).
  if (existingCmd.includes(tapDst)) {
    return { ok: true, noOp: true,
      message: "Capture is already enabled (tap marker found in statusLine.command)." };
  }

  // Backup: only if the .kos-bak file is absent — never overwrite the true original.
  // This ensures Disable can always restore the pre-tap state even if Enable is
  // called repeatedly (Q5 noOp guards against that, but belt-and-suspenders).
  if (!fs.existsSync(bakPath)) {
    try { fs.copyFileSync(settingsPath, bakPath); }
    catch { /* settings.json didn't exist yet — no backup needed */ }
  }

  // Q4: write the original command to disk (not env — fresh shell each turn).
  // Empty string is valid: means "no previous statusline", Disable will remove the key.
  try { fs.writeFileSync(prevPath, existingCmd, "utf8"); }
  catch (e) {
    return { ok: false, error: "Could not write prev file: " + e.message };
  }

  // Mutate settings: set statusLine.command to invoke the installed tap. Preserve
  // any existing statusLine.type / statusLine.padding (only swap `command`).
  settings.statusLine = Object.assign({}, sl, { command: "bash " + tapDst });

  // Atomic write: serialize, write to temp, rename. A crash mid-write leaves the
  // original intact because rename is atomic on the same filesystem.
  const tmp = settingsPath + ".kos-tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
    fs.renameSync(tmp, settingsPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup error */ }
    return { ok: false, error: "Could not write settings.json: " + e.message };
  }

  return { ok: true,
    message: "Capture enabled. Run a Claude Code turn to populate the bar." };
}

/**
 * Disable capture: restore settings.json to its pre-tap state, clean up all
 * installed files. Two robustness cases:
 *   1. .kos-bak present → restore it (canonical path).
 *   2. .kos-bak missing → reconstruct from the prev file (or remove the key).
 *
 * Returns:
 *   { ok: true }                              — disabled and cleaned up
 *   { ok: false, symlink: true, message }     — symlink: show removal instructions
 *   { ok: false, error: string }              — unexpected error
 *
 * @param {string} [claudeDir]  override ~/.claude dir (for tests)
 */
function disableCapture(claudeDir) {
  if (process.platform === "win32") {
    return { ok: false, win32: true,
      message: "Windows is not supported in v1." };
  }

  const dir          = claudeDir || path.join(os.homedir(), ".claude");
  const tapDst       = path.join(dir, "kos-burn-tap.sh");
  const settingsPath = path.join(dir, "settings.json");
  const bakPath      = path.join(dir, "settings.json.kos-bak");
  const prevPath     = path.join(dir, "kos-burn-bar-prev");
  const statePath    = path.join(dir, "kos-burn-bar-state.json");

  // Q3: detect symlink — if settings.json is a symlink, the user manages it in
  // their dotfiles; they need to remove the tap command manually.
  if (fs.existsSync(settingsPath)) {
    try {
      const real = fs.realpathSync(settingsPath);
      if (real !== settingsPath) {
        return {
          ok: false, symlink: true,
          message:
            "~/.claude/settings.json is a symlink. Remove the tap line from your " +
            'dotfile manually by deleting or reverting the "statusLine.command" entry ' +
            "that references kos-burn-tap.sh.",
        };
      }
    } catch { /* treat as plain file */ }
  }

  // Q6b: restore from .kos-bak if present; fall back to prev file.
  if (fs.existsSync(bakPath)) {
    // The backup is the gold standard — it's the unmodified pre-tap settings.json.
    try { fs.copyFileSync(bakPath, settingsPath); }
    catch (e) {
      return { ok: false, error: "Could not restore settings.json from backup: " + e.message };
    }
  } else {
    // No backup (e.g. first install predates backup, or file was absent). Reconstruct:
    // read the current settings, replace or remove statusLine.command from prev file.
    let settings = {};
    try {
      const raw = fs.readFileSync(settingsPath, "utf8");
      settings  = JSON.parse(raw);
    } catch {
      // Settings file missing or corrupt — nothing to restore, proceed with cleanup.
    }

    const prevCmd = fs.existsSync(prevPath)
      ? fs.readFileSync(prevPath, "utf8").trim()
      : "";

    const sl = (settings.statusLine && typeof settings.statusLine === "object")
      ? settings.statusLine : {};

    if (prevCmd) {
      // Re-instate the original command the user had before we wrapped it.
      settings.statusLine = Object.assign({}, sl, { command: prevCmd });
    } else {
      // No prev = user had no statusline before; remove the command key entirely
      // so settings.json is back to a clean state.
      const { command: _dropped, ...rest } = sl; // eslint-disable-line no-unused-vars
      if (Object.keys(rest).length > 0) {
        settings.statusLine = rest;
      } else {
        delete settings.statusLine;
      }
    }

    const tmp = settingsPath + ".kos-tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
      fs.renameSync(tmp, settingsPath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return { ok: false, error: "Could not write settings.json: " + e.message };
    }
  }

  // Clean up all installed files. Failures are tolerated — the important part (settings
  // restore) already succeeded. We delete silently so a partial uninstall doesn't error.
  for (const f of [tapDst, prevPath, statePath, bakPath]) {
    try { fs.unlinkSync(f); } catch { /* ok if already gone */ }
  }

  return { ok: true,
    message: "Capture disabled. Settings restored to original state." };
}



// ═════════════════════════════════════════════════════════════════════════════
//  VIEW
// ═════════════════════════════════════════════════════════════════════════════

class BurnBarView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin    = plugin;
    this.refreshId = null;
    this.tickId    = null;
    this.els       = {};

    // Last burn state read from disk. Rendering is a pure function of this plus
    // the current time (resets countdown + freshness), so tick() can re-render
    // the time-based bits each second WITHOUT re-reading the file. We never
    // extrapolate the percentage itself — it's an exact server value (Q1).
    this._state      = null;
    // mtime we last rendered. tick() polls the file's mtime (~1s) and only does a
    // full re-read when it changes — cheap "live" updates without fs.watch (Q1b).
    this._lastMtime  = null;
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return "KOS Burn Bar"; }
  getIcon()        { return "flame"; }

  async onOpen()  { this.buildShell(); this.refresh(); this.startTimers(); }
  async onClose() { this.stopTimers(); }

  // ── Timers ───────────────────────────────────────────────────────────────

  startTimers() {
    this.stopTimers();
    const ms = (this.plugin.settings.refreshSecs || 30) * 1000;
    this.refreshId = setInterval(() => this.refresh(), ms);
    this.tickId    = setInterval(() => this.tick(), 1000);
  }

  stopTimers() {
    if (this.refreshId) { clearInterval(this.refreshId); this.refreshId = null; }
    if (this.tickId)    { clearInterval(this.tickId);    this.tickId    = null; }
  }

  // ── Formatters ───────────────────────────────────────────────────────────
  // Only fmtDuration + fmtTime are live: both called by renderReset().
  // The old fmt/ticks/timeAgo/shortModel helpers were removed as dead weight
  // when the token-math path was deleted (they rendered token counts + model
  // names that no longer exist in the UI).

  fmtDuration(ms) {
    if (ms <= 0) return "0m";
    const totalSec = Math.floor(ms / 1000);
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h === 0 && m < 10) return `${m}m ${s}s`;
    if (h > 0) {
      const mR = s >= 30 ? m + 1 : m;
      return mR < 60 ? `${h}h ${mR}m` : `${h + 1}h 0m`;
    }
    const mR = s >= 30 ? m + 1 : m;
    return mR < 60 ? `${mR}m` : "1h 0m";
  }

  fmtTime(date) {
    if (!date) return "—";
    const tz = this.plugin.settings.timezone || "America/New_York";
    try {
      return date.toLocaleTimeString("en-US", {
        timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
      });
    } catch {
      return date.toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", hour12: true,
      });
    }
  }


  // ── Phase 1: Build DOM shell once ────────────────────────────────────────

  buildShell() {
    const el = this.contentEl;
    el.empty();
    const e = this.els;

    const root  = el.createDiv({ cls: "kos-burn-root" });
    const panel = root.createDiv({ cls: "kos-panel" });

    // Label row — title + freshness affordance (live dot goes green when fresh).
    const labelRow  = panel.createDiv({ cls: "kos-label-row" });
    const labelLeft = labelRow.createDiv({ cls: "kos-label-left" });
    labelLeft.createSpan({ text: "TOKEN BURN · CLAUDE CODE  " });
    e.liveDot = labelLeft.createSpan({ cls: "kos-live-dot" });
    e.liveLabel = labelLeft.createSpan({ cls: "kos-live-label", text: "" });
    // Right side: "Xm ago" / "stale" — hidden when live (live label is beside dot).
    e.fresh = labelRow.createDiv({ cls: "kos-label-right" });

    // Bar 1 — 5-hour window (server five_hour.used_percentage).
    const l1 = panel.createDiv({ cls: "kos-row-label" });
    l1.textContent = "5-HOUR WINDOW";
    e.five = this.buildBarShell(panel, true);

    panel.createDiv({ cls: "kos-divider" });

    // Bar 2 — weekly / 7-day window (server seven_day.used_percentage).
    const l2 = panel.createDiv({ cls: "kos-row-label" });
    l2.textContent = "WEEKLY · 7-DAY";
    e.seven = this.buildBarShell(panel, false);

    panel.createDiv({ cls: "kos-divider" });

    // Metrics row — JSONL-derived supplementary stats (burn rate, cost, model).
    const metricsRow = panel.createDiv({ cls: "kos-stats-row" });

    const burn = this.buildStatShell(metricsRow);
    burn.label.textContent = "BURN RATE";
    e.burnValue = burn.value; e.burnSub = burn.sub;

    const cost = this.buildStatShell(metricsRow);
    cost.label.textContent = "API COST RATE";
    e.costValue = cost.value; e.costSub = cost.sub;

    const model = this.buildStatShell(metricsRow);
    model.label.textContent = "MODEL";
    e.modelValue = model.value; e.modelSub = model.sub;

    panel.createDiv({ cls: "kos-divider" });

    // Resets row — per-window reset countdowns (from server resets_at).
    const statsRow = panel.createDiv({ cls: "kos-stats-row" });

    const r5 = this.buildStatShell(statsRow);
    r5.label.textContent = "5H RESETS IN";
    e.fiveReset = r5.value; e.fiveResetSub = r5.sub;

    const r7 = this.buildStatShell(statsRow);
    r7.label.textContent = "WEEKLY RESETS IN";
    e.weekReset = r7.value; e.weekResetSub = r7.sub;

    const rc = this.buildStatShell(statsRow);
    rc.label.textContent = "CONTEXT";
    e.contextValue = rc.value; e.contextSub = rc.sub;

    e.errorEl = panel.createDiv({ cls: "kos-error" });
    e.errorEl.style.display = "none";
  }

  buildBarShell(parent, big) {
    const row      = parent.createDiv({ cls: "kos-burn-row" });
    const pctBlock = row.createDiv({ cls: "kos-pct-block" });
    const pctEl    = pctBlock.createSpan({
      cls: "kos-pct-number" + (big ? "" : " kos-small"), text: "0",
    });
    pctBlock.createSpan({ cls: "kos-pct-symbol", text: "%" });

    const barWrap  = row.createDiv({ cls: "kos-bar-wrap" });
    const barTrack = barWrap.createDiv({ cls: "kos-bar-track" + (big ? "" : " kos-thin") });
    const fill     = barTrack.createDiv({ cls: "kos-bar-fill" });
    const hatch    = barTrack.createDiv({ cls: "kos-bar-hatch" });
    fill.style.width  = "0%";
    hatch.style.width = "100%";

    const tickRow   = barWrap.createDiv({ cls: "kos-bar-ticks" });
    const tickSpans = [0,1,2,3,4].map(() => tickRow.createSpan({ text: "—" }));

    const countBlock = row.createDiv({ cls: "kos-count-block" });
    const usedEl  = countBlock.createDiv({
      cls: "kos-count-used" + (big ? "" : " kos-small"), text: "—",
    });
    const limitEl = countBlock.createDiv({ cls: "kos-count-limit", text: "/ —" });

    return { pctEl, fill, hatch, tickSpans, usedEl, limitEl };
  }

  buildStatShell(parent) {
    const cell  = parent.createDiv({ cls: "kos-stat" });
    const label = cell.createDiv({ cls: "kos-stat-label" });
    const value = cell.createDiv({ cls: "kos-stat-value", text: "—" });
    const sub   = cell.createDiv({ cls: "kos-stat-sub",   text: "" });
    return { label, value, sub };
  }


  // ── Phase 2: Read the captured state + render ────────────────────────────
  //
  // Rendering is split: refresh() reads the file and renders; renderState() is a
  // pure function of (state, now) so tick() can re-run it every second to age the
  // freshness label and tick down the reset countdowns WITHOUT touching disk.
  // The percentage itself is never extrapolated — it's an exact server value.

  // refresh() accepts the observed mtime so the caller (tick) can hand it in
  // directly — this avoids the re-read loop bug where a persistent parse failure
  // returned the keep-last-good state whose mtimeMs was the OLD good file, not
  // the current file, causing tick() to see an eternal mismatch and loop forever.
  refresh(observedMtime) {
    const st = readBurnState();   // server-authoritative; never throws
    this._state     = st;
    // Track the OBSERVED file mtime (the one we just stat'd) rather than the
    // rendered state's mtime. On a corrupt/empty file, readBurnState() returns
    // last-good whose mtimeMs is the old good file — using that would put us
    // back to an eternal mismatch. observedMtime is what tick() already stat'd;
    // refresh() called directly (from onOpen or settings) passes undefined, so
    // we fall back to the state's own mtime (first load is fine, only looping
    // is a risk when the file is persistently corrupt).
    this._lastMtime = observedMtime !== undefined ? observedMtime : st.mtimeMs;
    this.renderState(st);

    // Supplementary metrics from JSONL (burn rate, cost, model). Reading the
    // project dirs is slower than the state-file read, so do it here in refresh()
    // (every refreshSecs, default 5s) rather than in tick() (every 1s).
    try {
      const s       = this.plugin.settings;
      const records = readAllRecords(s.projectFilter || "");
      this._metrics = computeMetrics(records);
    } catch { this._metrics = null; }
    this.renderMetrics(this._metrics);
  }

  renderState(st) {
    const e = this.els;
    if (!e.five) return;          // shell not built yet

    const fresh = burnFreshness(st.mtimeMs);   // "live" | "recent" | "stale"

    // Freshness affordance: recording-red REC dot when live, label shows
    // live/Xm ago/stale. The dot is red (--kos-rec) not green — it signals
    // "actively recording" (like a REC indicator), not "health OK".
    e.liveDot.classList.toggle("kos-dot-live",  fresh === "live");
    e.liveDot.classList.toggle("kos-dot-stale", fresh !== "live");
    // "LIVE" text sits beside the dot; right side shows time only when not live.
    e.liveLabel.textContent = fresh === "live" ? " LIVE" : "";
    e.fresh.textContent =
      fresh === "live"   ? ""
      : fresh === "recent" ? "updated " + this.mtimeAgo(st.mtimeMs)
      : "stale — no capture";

    // >5h with no new capture means the 5h number has rolled over and is
    // meaningless -> dim both bars to --% rather than show a stale figure (Q1b).
    const dim = fresh === "stale";
    const m5      = this._metrics;
    const limit5  = (this.plugin.settings && this.plugin.settings.manualLimit) || 0;
    this.renderBar(e.five,  dim ? null : st.fiveHour,  (!dim && m5) ? m5.fiveHourTokens : null, limit5);
    this.renderBar(e.seven, dim ? null : st.sevenDay,   (!dim && m5) ? m5.sevenDayTokens : null, 0);

    // Per-window reset countdowns (recomputed each tick from absolute resets_at).
    // When the window is stale (dim), the old resets_at would show "~0m" which
    // reads as "imminent reset" — misleading. Render "—" instead so it's clear
    // the data is simply expired, not that a reset is about to fire.
    if (dim) {
      e.fiveReset.textContent = "—"; e.fiveResetSub.textContent = "";
      e.weekReset.textContent = "—"; e.weekResetSub.textContent = "";
    } else {
      this.renderReset(e.fiveReset, e.fiveResetSub, st.fiveHourResetsAt, { showDay: true });
      this.renderReset(e.weekReset, e.weekResetSub, st.sevenDayResetsAt, { showDay: true, showDate: true });
    }

    // Help line only when we've literally never captured anything.
    const noData = st.mtimeMs == null;
    e.errorEl.style.display = noData ? "block" : "none";
    e.errorEl.textContent   =
      "No capture yet — enable capture in settings, then run a Claude Code turn.";
  }

  // Render one percentage bar. pct == null -> dimmed "--%" (missing/stale), never
  // a fabricated 0. Ticks are fixed percentage gradations for a 0–100 bar.
  renderBar(bar, pct, tokens = null, limit = 0) {
    const TICKS = ["0", "25", "50", "75", "100"];
    TICKS.forEach((t, i) => { bar.tickSpans[i].textContent = t; });
    if (pct == null) {
      bar.pctEl.textContent   = "--";
      bar.pctEl.classList.add("kos-stale");
      bar.fill.style.width    = "0%";
      bar.hatch.style.width   = "100%";
      bar.usedEl.textContent  = "—";
      bar.limitEl.textContent = "";
      return;
    }
    const rounded = Math.round(pct * 10) / 10;   // 1 decimal — matches CC's UI
    bar.pctEl.classList.remove("kos-stale");
    bar.pctEl.textContent   = String(rounded);
    bar.fill.style.width    = Math.min(rounded, 100) + "%";
    bar.hatch.style.width   = Math.max(100 - rounded, 0) + "%";
    bar.usedEl.textContent  = tokens != null ? fmtTokensK(tokens) : "—";
    bar.limitEl.textContent = "BURNED";
  }

  renderReset(valueEl, subEl, resetsAt, opts = {}) {
    const ms = this.resetMsRemaining(resetsAt);
    if (ms == null) { valueEl.textContent = "—"; subEl.textContent = ""; return; }
    valueEl.textContent = "~" + this.fmtDuration(ms);
    const d  = new Date(this.resetEpochMs(resetsAt));
    const tz = this.plugin.settings.timezone || "America/New_York";
    let sub  = "@ ";
    if (opts.showDay) {
      try { sub += d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" }) + " "; }
      catch { sub += d.toLocaleDateString("en-US", { weekday: "short" }) + " "; }
    }
    if (opts.showDate) {
      try { sub += d.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" }) + " "; }
      catch { sub += d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " "; }
    }
    sub += this.fmtTime(d);
    subEl.textContent = sub;
  }

  // resets_at may be epoch seconds, epoch ms, or an ISO string (varies by CC
  // version). Normalize to epoch ms; null if unparseable.
  resetEpochMs(resetsAt) {
    if (resetsAt == null) return null;
    if (typeof resetsAt === "string") {
      const t = Date.parse(resetsAt);
      return isNaN(t) ? null : t;
    }
    // <1e12 is a 10-digit seconds epoch; otherwise already ms.
    return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  }

  resetMsRemaining(resetsAt) {
    const ms = this.resetEpochMs(resetsAt);
    return ms == null ? null : Math.max(ms - Date.now(), 0);
  }

  mtimeAgo(mtimeMs) {
    const s = Math.round((Date.now() - mtimeMs) / 1000);
    if (s < 60)   return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    return Math.round(s / 3600) + "h ago";
  }

  // Shorten a model ID to a human-readable label.
  // e.g. "claude-sonnet-4-6" → "Sonnet 4.6", "claude-haiku-4-5-20251001" → "Haiku 4.5"
  shortModel(name) {
    if (!name) return "Unknown";
    const m = name.match(/claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
    if (!m) return name.slice(0, 18);
    const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    const ver    = m[3] ? `${m[2]}.${m[3]}` : m[2];
    return `${family} ${ver}`;
  }

  renderMetrics(m) {
    const e = this.els;
    if (!e.burnValue) return;
    if (!m) {
      e.burnValue.textContent    = "—";
      e.burnSub.textContent      = "";
      e.costValue.textContent    = "—";
      e.costSub.textContent      = "";
      e.modelValue.textContent   = "—";
      e.modelSub.textContent     = "";
      e.contextValue.textContent = "—";
      e.contextSub.textContent   = "";
      return;
    }
    e.burnValue.textContent  = m.burnRate.toFixed(1) + " tokens/min";
    // Estimate time until 5h window exhausts based on current burn rate + known limit.
    const limit5e = (this.plugin.settings && this.plugin.settings.manualLimit) || 0;
    const pct5e   = this._state && this._state.fiveHour;
    if (m.burnRate > 0 && limit5e > 0 && pct5e != null) {
      const remaining = (1 - pct5e / 100) * limit5e;
      const minsLeft  = remaining / m.burnRate;
      e.burnSub.textContent = "~" + this.fmtDuration(minsLeft * 60000) + " remaining";
    } else {
      e.burnSub.textContent = "";
    }
    e.costValue.textContent  = m.costRate.toFixed(4) + " /min";
    e.costSub.textContent    = m.costUsed.toFixed(3) + " used via API";
    const top = m.models[0];
    e.modelValue.textContent = top ? this.shortModel(top.name) : "—";
    e.modelSub.textContent   = m.models.length > 0
      ? m.models.map(x => this.shortModel(x.name) + " " + x.pct + "%").join(" · ")
      : "";
    if (m.contextPct != null) {
      e.contextValue.textContent = m.contextPct.toFixed(1) + "%";
      e.contextSub.textContent   = fmtTokensK(m.contextTokens) + " / 200k";
    } else {
      e.contextValue.textContent = "—";
      e.contextSub.textContent   = "";
    }
  }

  /**
   * Runs every ~1s. Polls the state file's mtime: on change, do a full re-read
   * (this is what makes the bar feel "live" — it updates within ~1s of the tap
   * writing, with no fs.watch). On no change, re-render the existing state so the
   * countdowns tick down and the freshness label ages (live -> Xm ago -> stale).
   */
  tick() {
    if (!this.els.five) return;

    let mtime = null;
    try { mtime = fs.statSync(BURN_STATE_FILE).mtimeMs; } catch { /* no file yet */ }

    if (mtime !== this._lastMtime) {
      // Pass the observed mtime directly so refresh() records it regardless of
      // whether the read succeeds. If the file is persistently corrupt,
      // readBurnState() returns keep-last-good (whose mtimeMs is from an earlier
      // good file), but we MUST update _lastMtime to the current file's mtime to
      // avoid re-triggering refresh() on every tick (an infinite re-read loop).
      this.refresh(mtime);
      return;
    }
    if (this._state) this.renderState(this._state);  // age time-based bits only
  }
}


// ═════════════════════════════════════════════════════════════════════════════
//  SETTINGS TAB
// ═════════════════════════════════════════════════════════════════════════════

class BurnBarSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  _refreshViews() {
    this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE)
      .forEach(l => { if (l.view instanceof BurnBarView) l.view.refresh(); });
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "KOS Burn Bar Settings" });

    // ── Capture section ───────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Capture hook" });

    // Result area — cleared and rebuilt on each button click.
    const resultArea = containerEl.createDiv({ cls: "kos-capture-result" });
    resultArea.style.marginBottom = "12px";
    if (this.plugin.settings.captureEnabled) {
      resultArea.createEl("p", {
        text: "✅ Capture is enabled. The tap is installed and active.",
        cls: "kos-capture-ok",
      });
    }

    new Setting(containerEl)
      .setName("Enable capture")
      .setDesc(
        "Installs kos-burn-tap.sh to ~/.claude/ and wires it into your Claude Code " +
        "statusLine.command. The tap is invisible — it writes nothing to your statusline " +
        "and chains any existing command. Backup is automatic (settings.json.kos-bak)."
      )
      .addButton(btn => btn
        .setButtonText("Enable capture")
        .onClick(async () => {
          resultArea.empty();
          const result = enableCapture(null, this.plugin._tapSrcPath());
          if (result.ok) {
            this.plugin.settings.captureEnabled = true;
            await this.plugin.saveSettings();
            resultArea.createEl("p", {
              text: "✅ " + (result.message || "Capture enabled."),
              cls: "kos-capture-ok",
            });
          } else if (result.symlink) {
            this._buildSymlinkGuide(resultArea, result);
          } else if (result.win32) {
            resultArea.createEl("p", { text: "⚠️ Windows is not supported in v1 (bash tap requires macOS/Linux)." });
          } else {
            resultArea.createEl("p", { text: "❌ " + (result.error || "Enable failed — check the developer console.") });
          }
          this._refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("Disable capture")
      .setDesc(
        "Restores settings.json from the backup (or reconstructs from the prev file), " +
        "removes the tap script and all state files. Run this before uninstalling the plugin."
      )
      .addButton(btn => btn
        .setButtonText("Disable capture")
        .setWarning()
        .onClick(async () => {
          resultArea.empty();
          const result = disableCapture();
          if (result.ok) {
            this.plugin.settings.captureEnabled = false;
            await this.plugin.saveSettings();
            resultArea.createEl("p", {
              text: "✅ " + (result.message || "Capture disabled."),
              cls: "kos-capture-ok",
            });
          } else if (result.symlink) {
            const p = resultArea.createEl("p");
            p.textContent =
              "⚠️ Your ~/.claude/settings.json is a symlink. Remove the tap line manually " +
              'from your dotfile by deleting the "statusLine.command" entry that references ' +
              "kos-burn-tap.sh, then re-sync your dotfiles.";
          } else {
            resultArea.createEl("p", { text: "❌ " + (result.error || "Disable failed — check the developer console.") });
          }
          this._refreshViews();
        })
      );

    // ── Display section ───────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Display" });

    new Setting(containerEl)
      .setName("Refresh interval (seconds)")
      .setDesc("How often to re-read session logs for burn rate and model breakdown. Default: 5s. File cache keeps CPU impact minimal.")
      .addText(text => text
        .setPlaceholder("5")
        .setValue(String(this.plugin.settings.refreshSecs))
        .onChange(async (v) => {
          this.plugin.settings.refreshSecs = parseInt(v) || 5;
          await this.plugin.saveSettings();
          this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE)
            .forEach(l => l.view instanceof BurnBarView && l.view.startTimers());
        })
      );

    new Setting(containerEl)
      .setName("Timezone")
      .setDesc("IANA timezone for reset time display (e.g. America/New_York).")
      .addText(text => text
        .setPlaceholder("America/New_York")
        .setValue(this.plugin.settings.timezone)
        .onChange(async (v) => {
          this.plugin.settings.timezone = v || "America/New_York";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Project filter")
      .setDesc("Limit burn rate and model stats to one project. Enter part of your working directory name (e.g. 'my-project'). Leave blank to track all projects.")
      .addText(text => text
        .setPlaceholder("blank = all projects")
        .setValue(this.plugin.settings.projectFilter || "")
        .onChange(async (v) => {
          this.plugin.settings.projectFilter = v.trim();
          await this.plugin.saveSettings();
          this._refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("Auto-open on vault start")
      .setDesc("Automatically show the burn bar panel when you open this vault.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoOpen)
        .onChange(async (v) => {
          this.plugin.settings.autoOpen = v;
          await this.plugin.saveSettings();
        })
      );
  }

  // Build a step-by-step guide for symlink users. Called after enableCapture()
  // returns {ok:false, symlink:true} — the tap file is already installed at this
  // point, so the user only needs to add one line to their dotfile.
  _buildSymlinkGuide(container, result) {
    const tapCmd    = result.tapCmd  || ("bash " + result.tapDst);
    const chainCmd  = tapCmd + " | <your-existing-command>";
    const snippet   = `"statusLine": { "command": "${tapCmd}" }`;
    const chainSnip = `"statusLine": { "command": "${chainCmd}" }`;

    const guide = container.createDiv({ cls: "kos-symlink-guide" });
    guide.style.cssText = "border-left:3px solid var(--color-accent);padding:10px 14px;margin:8px 0;font-size:0.88em;line-height:1.6";

    guide.createEl("p", { text: "✅ Tap script installed to: " + result.tapDst });

    guide.createEl("p", {
      text: "⚠️  Your ~/.claude/settings.json is managed by a dotfile system (symlink detected). " +
            "Auto-edit is disabled to avoid dirtying your dotfiles repo. " +
            "Follow these steps to wire the tap manually:",
    });

    const steps = [
      "Open your dotfile's settings.json (the real file behind the symlink).",
      'Add or update the statusLine.command key:',
      'If you already have a statusLine.command, chain it instead:',
      "Re-sync your dotfiles (e.g. stow ., chezmoi apply).",
      "Restart Claude Code — the bar will populate on your next turn.",
    ];

    steps.forEach((step, i) => {
      const row = guide.createDiv();
      row.style.cssText = "margin-top:8px";
      row.createEl("strong", { text: `Step ${i + 1}: ` });
      row.createSpan({ text: step });

      if (i === 1) {
        this._codeBlock(guide, snippet);
      } else if (i === 2) {
        this._codeBlock(guide, chainSnip);
      }
    });
  }

  _codeBlock(parent, text) {
    const wrap = parent.createDiv();
    wrap.style.cssText = "display:flex;align-items:center;gap:8px;margin:4px 0 8px";
    const pre = wrap.createEl("code");
    pre.style.cssText = "flex:1;background:var(--background-modifier-form-field);padding:6px 10px;border-radius:4px;font-size:0.9em;word-break:break-all";
    pre.textContent = text;
    const btn = wrap.createEl("button", { text: "Copy" });
    btn.style.cssText = "padding:4px 10px;font-size:0.8em;cursor:pointer;flex-shrink:0";
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy"; }, 1500);
      });
    });
  }
}


// ═════════════════════════════════════════════════════════════════════════════
//  PLUGIN
// ═════════════════════════════════════════════════════════════════════════════

class KosBurnBarPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new BurnBarView(leaf, this));

    this.addCommand({
      id: "open-burn-bar", name: "Open KOS Burn Bar",
      callback: () => this.activateView(),
    });

    this.addRibbonIcon("flame", "KOS Burn Bar", () => this.activateView());

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autoOpen) this.activateView();
    });

    this.addSettingTab(new BurnBarSettingTab(this.app, this));

    // Q6 self-heal: if the user has enabled capture but the tap has gone missing
    // (e.g. they reinstalled the plugin, or manually deleted the tap), silently
    // reinstall it so the bar keeps working. We do NOT teardown in onunload() —
    // that fires on every Obsidian close/update and would break the statusline for
    // users who simply restart Obsidian without disabling first.
    if (this.settings.captureEnabled) {
      try {
        this._selfHealCapture();
      } catch (e) {
        console.error("[kos-burn-bar] self-heal threw unexpectedly:", e);
      }
    }
  }

  // Self-heal: check whether the installed tap and prev file are present. If either
  // is missing, re-run enableCapture to restore the full install. This handles the
  // "reinstall plugin without Disable" case (Q6). Runs silently — no user prompt.
  _selfHealCapture() {
    const dir     = path.join(os.homedir(), ".claude");
    const tapDst  = path.join(dir, "kos-burn-tap.sh");
    const prevPath = path.join(dir, "kos-burn-bar-prev");
    // If tap or prev is missing, re-install. We check both because:
    //   - tap missing → statusline command references a non-existent script (breaks CC)
    //   - prev missing → Disable would have no fallback for the original command
    if (!fs.existsSync(tapDst) || !fs.existsSync(prevPath)) {
      const result = enableCapture(null, this._tapSrcPath());
      if (!result.ok) {
        console.error("[kos-burn-bar] self-heal failed to reinstall tap:", result.error || result.message);
      }
    }
  }

  // Resolve the tap source script on disk. __dirname points inside Electron's asar
  // archive at runtime, so we derive the real path from the vault adapter + manifest.
  _tapSrcPath() {
    try {
      const base = this.app.vault.adapter.basePath;
      return path.join(base, this.manifest.dir, "kos-burn-tap.sh");
    } catch {
      return TAP_SRC_DEFAULT;   // tests / fallback
    }
  }

  onunload() {
    // No teardown: detach the view but leave the tap in place. onunload fires on
    // every Obsidian close/update — tearing down capture here would break the CC
    // statusline every time Obsidian restarts. Uninstall = explicit Disable button.
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    // Right sidebar is idiomatic for monitoring panels
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    leaf.setPinned(true);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = KosBurnBarPlugin;

module.exports._test = {
  // Datasource: server rate_limits via the statusline tap.
  readBurnState,
  burnFreshness,
  // Clears the module-level keep-last-good cache so each test starts isolated.
  _resetBurnStateCache: () => { lastGoodBurnState = null; },
  BurnBarView,
  // Install/uninstall — exported for jest (tests pass a tmpdir to redirect paths).
  enableCapture,
  disableCapture,
};

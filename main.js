/*
 * KOS Burn Bar — Obsidian Plugin  v5
 * Reads Claude Code JSONL session logs from ~/.claude/projects/
 * and renders a live token burn + message usage bar.
 *
 * Architecture matches Claude Code Monitor (CCM) v3:
 *  - Session blocks anchored to actual first-message timestamp
 *  - UUID-based deduplication
 *  - <synthetic> model filtering
 *  - Active block = block whose endTime > now
 *  - Reset time = active block endTime
 *  - Burn rate = last 60 minutes / 60
 *  - Inter-refresh extrapolation via tick() for fluid bar motion
 *
 * No build step. Drop main.js + manifest.json + styles.css
 * into .obsidian/plugins/kos-burn-bar/
 */

const { Plugin, ItemView, PluginSettingTab, Setting } = require("obsidian");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ─── Constants ───────────────────────────────────────────────────────────────
const VIEW_TYPE      = "kos-burn-bar-view";
const CLAUDE_DIR     = path.join(os.homedir(), ".claude", "projects");
const WINDOW_HOURS   = 5;
const HISTORY_DAYS   = 8;
// A gap longer than this between messages starts a new session block.
// 1h matches claude.ai's session boundary behavior (vs the old 5h which
// grouped morning and afternoon messages into one block, skewing reset time).
const SESSION_GAP_MS = 60 * 60 * 1000;

// Per-model tiered pricing ($/token). Matches Anthropic public pricing.
const PRICING = {
  opus:    { input: 15/1e6,   output: 75/1e6,  cacheWrite: 18.75/1e6, cacheRead: 1.50/1e6 },
  sonnet:  { input: 3/1e6,    output: 15/1e6,  cacheWrite: 3.75/1e6,  cacheRead: 0.30/1e6 },
  haiku:   { input: 0.80/1e6, output: 4/1e6,   cacheWrite: 1.00/1e6,  cacheRead: 0.08/1e6 },
  default: { input: 3/1e6,    output: 15/1e6,  cacheWrite: 3.75/1e6,  cacheRead: 0.30/1e6 },
};

/**
 * Parse a user-supplied reset time string ("14:45" or "2:45 PM") into a Date
 * for today. Returns null if the string is empty, invalid, or already past.
 * Expired overrides return null so the bar reverts to log-derived values.
 */
function parseResetOverride(str) {
  if (!str || !str.trim()) return null;
  const m = str.trim().match(/^(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/i);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const meridiem = m[3] ? m[3].toLowerCase() : null;
  if (meridiem === "pm" && h < 12) h += 12;
  if (meridiem === "am" && h === 12) h = 0;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0);
  return t > now ? t : null;
}

function getPrice(model) {
  if (!model) return PRICING.default;
  if (model.includes("opus"))  return PRICING.opus;
  if (model.includes("haiku")) return PRICING.haiku;
  return PRICING.sonnet;
}

function recordCost(r) {
  const p = getPrice(r.model);
  return r.inputTokens      * p.input
       + r.cacheCreateTokens * p.cacheWrite
       + r.cacheReadTokens   * p.cacheRead
       + r.outputTokens      * p.output;
}

const DEFAULT_SETTINGS = {
  manualLimit:       0,
  fallbackLimit:     44000,
  refreshSecs:       5,
  autoOpen:          true,
  timezone:          "America/New_York",
  projectFilter:     "",
  resetTimeOverride: "",
};


// ═════════════════════════════════════════════════════════════════════════════
//  FILE CACHE
// ═════════════════════════════════════════════════════════════════════════════

// Keyed by absolute filepath → { mtime: number, records: array }
// Avoids re-parsing unchanged JSONL files on every refresh.
const fileCache = new Map();

function getCachedFile(filepath) {
  let mtime;
  try { mtime = fs.statSync(filepath).mtimeMs; }
  catch { return []; }

  const hit = fileCache.get(filepath);
  if (hit && hit.mtime === mtime) return hit.records;

  const records = [];
  parseFile(filepath, records);
  fileCache.set(filepath, { mtime, records });
  return records;
}


// ═════════════════════════════════════════════════════════════════════════════
//  JSONL PARSER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Recursively walk ~/.claude/projects/ and collect every .jsonl file.
 * Uses getCachedFile so only modified files are re-parsed.
 * projectFilter (optional substring): when set, only reads from project
 * directories whose name contains that text. Leave blank for all projects.
 */
function readAllRecords(projectFilter, claudeDir) {
  const dir = claudeDir || CLAUDE_DIR;
  const records = [];
  if (!fs.existsSync(dir)) return records;

  const substringFilter = projectFilter || "";

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return records; }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (substringFilter && !ent.name.includes(substringFilter)) continue;
    const projDir = path.join(dir, ent.name);
    (function walk(dir) {
      let sub;
      try { sub = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of sub) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".jsonl")) {
          for (const r of getCachedFile(full)) records.push(r);
        }
      }
    })(projDir);
  }

  return records;
}

/**
 * Parse one JSONL file into records.
 *
 * CCM reference: src/claude_monitor/data/reader.py _map_to_usage_entry()
 * CCM reference: src/claude_monitor/core/data_processors.py TokenExtractor
 */
function parseFile(filepath, records) {
  let data;
  try { data = fs.readFileSync(filepath, "utf-8"); }
  catch { return; }

  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); }
    catch { continue; }

    const tsRaw = obj.timestamp;
    if (!tsRaw) continue;
    let ts;
    try { ts = new Date(tsRaw); if (isNaN(ts.getTime())) continue; }
    catch { continue; }

    const msgType = obj.type;
    const uuid    = obj.uuid || null;

    if (msgType === "user") {
      records.push({
        uuid, timestamp: ts,
        inputTokens: 0, outputTokens: 0,
        cacheCreateTokens: 0, cacheReadTokens: 0,
        isUserMessage: true, model: null,
      });
    } else if (msgType === "assistant") {
      const msg   = obj.message || {};
      const usage = msg.usage;
      if (!usage) continue;

      const model = msg.model || null;
      if (model === "<synthetic>") continue;

      const inp         = usage.input_tokens                  || 0;
      const out         = usage.output_tokens                 || 0;
      const cacheCreate = usage.cache_creation_input_tokens   || 0;
      const cacheRead   = usage.cache_read_input_tokens       || 0;
      if (inp === 0 && out === 0 && cacheCreate === 0 && cacheRead === 0) continue;

      records.push({
        uuid, timestamp: ts,
        inputTokens: inp, outputTokens: out,
        cacheCreateTokens: cacheCreate, cacheReadTokens: cacheRead,
        isUserMessage: false, model,
      });
    }
  }
}


// ═════════════════════════════════════════════════════════════════════════════
//  DEDUPLICATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Remove duplicate records by UUID.
 * CCM reference: src/claude_monitor/data/reader.py _create_unique_hash()
 */
function deduplicateRecords(records) {
  const seen = new Set();
  const result = [];
  for (const r of records) {
    if (r.uuid) {
      if (seen.has(r.uuid)) continue;
      seen.add(r.uuid);
    }
    result.push(r);
  }
  return result;
}


// ═════════════════════════════════════════════════════════════════════════════
//  SESSION BLOCKS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Group records into 5-hour session blocks.
 * Block start = actual first-message timestamp (not floored to hour).
 * This aligns with claude.ai's own timer.
 *
 * CCM reference: src/claude_monitor/data/analyzer.py transform_to_blocks()
 */
function buildSessionBlocks(records) {
  const windowMs = WINDOW_HOURS * 3600000;

  const assistantRecs = records
    .filter(r => !r.isUserMessage)
    .sort((a, b) => a.timestamp - b.timestamp);

  const userRecs = records
    .filter(r => r.isUserMessage)
    .sort((a, b) => a.timestamp - b.timestamp);

  const blocks = [];
  let cur = null;

  for (const r of assistantRecs) {
    const needsNew = !cur
      || r.timestamp >= cur.endTime
      || (r.timestamp - cur.lastTs) >= SESSION_GAP_MS;

    if (needsNew) {
      // Anchor to the earliest user message that precedes this assistant record
      // and falls within SESSION_GAP_MS — matches claude.ai's session timer which
      // starts from the user's first message, not the first response.
      const prevEnd = cur ? cur.endTime : new Date(0);
      const anchor  = userRecs.find(u =>
        u.timestamp >= prevEnd &&
        u.timestamp <  r.timestamp &&
        (r.timestamp - u.timestamp) < SESSION_GAP_MS
      );
      const blockStart = anchor ? anchor.timestamp : r.timestamp;
      const blockEnd   = new Date(blockStart.getTime() + windowMs);
      cur = {
        startTime:        blockStart,
        endTime:          blockEnd,
        totalInput:       0,
        totalOutput:      0,
        totalCacheCreate: 0,
        totalCacheRead:   0,
        totalCost:        0,
        messages:         0,
        lastTs:           r.timestamp,
        modelTokens:      {},
      };
      blocks.push(cur);
    }

    cur.totalInput       += r.inputTokens;
    cur.totalOutput      += r.outputTokens;
    cur.totalCacheCreate += r.cacheCreateTokens;
    cur.totalCacheRead   += r.cacheReadTokens;
    cur.totalCost        += recordCost(r);
    cur.lastTs            = r.timestamp;

    if (r.model) {
      const t = r.inputTokens + r.outputTokens;
      cur.modelTokens[r.model] = (cur.modelTokens[r.model] || 0) + t;
    }
  }

  for (const r of userRecs) {
    for (const b of blocks) {
      if (r.timestamp >= b.startTime && r.timestamp < b.endTime) {
        b.messages++;
        break;
      }
    }
  }

  return blocks;
}


// ═════════════════════════════════════════════════════════════════════════════
//  LIMIT DETECTION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Auto-detect token limit using p90 of COMPLETED session block totals.
 *
 * Using only completed blocks (endTime < now) prevents the current session
 * from setting its own limit (circular: limit = current usage = 100% always).
 * p90 follows CCM's methodology (src/claude_monitor/core/p90_calculator.py)
 * and ignores outlier sessions that blew past the actual rate limit.
 */
function detectTokenLimit(records, fallback) {
  const now    = new Date();
  const cutoff = new Date(now.getTime() - HISTORY_DAYS * 86400000);

  const recent = records.filter(r => !r.isUserMessage && r.timestamp >= cutoff);
  if (recent.length === 0) return fallback;

  const deduped = deduplicateRecords(recent);
  const blocks  = buildSessionBlocks(deduped);

  // Only completed blocks — current active block excluded to avoid circular limit.
  const completedTotals = blocks
    .filter(b => b.endTime <= now && (b.totalInput + b.totalOutput) > 0)
    .map(b => b.totalInput + b.totalOutput)
    .sort((a, b) => a - b);

  if (completedTotals.length === 0) return fallback;

  const p90idx = Math.min(Math.floor(completedTotals.length * 0.9), completedTotals.length - 1);
  return completedTotals[p90idx] > 0 ? completedTotals[p90idx] : fallback;
}


// ═════════════════════════════════════════════════════════════════════════════
//  COMPUTE USAGE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Compute the full usage summary for the burn bar.
 * Returns hasData (based on deduped records) so the error check
 * is not fooled by pre-filter raw records that have no real usage.
 */
function computeUsage(records, tokenLimit) {
  const now     = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60000);

  const deduped = deduplicateRecords(records);
  const blocks  = buildSessionBlocks(deduped);

  // Active block: endTime > now AND last message < 5h old.
  let activeBlock = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.endTime > now) {
      const lastMsgAge = now - b.lastTs;
      if (lastMsgAge < WINDOW_HOURS * 3600000) activeBlock = b;
      break;
    }
  }

  const totalInput   = activeBlock ? activeBlock.totalInput  : 0;
  const totalOutput  = activeBlock ? activeBlock.totalOutput : 0;
  const messagesUsed = activeBlock ? activeBlock.messages    : 0;
  const lastTs       = activeBlock ? activeBlock.lastTs      : null;
  const modelTokens  = activeBlock ? activeBlock.modelTokens : {};
  const tokensUsed   = totalInput + totalOutput;

  const sessionStart      = activeBlock ? activeBlock.startTime : null;
  const sessionEnd        = activeBlock ? activeBlock.endTime   : null;
  const windowRemainingMs = sessionEnd
    ? Math.max(sessionEnd.getTime() - now.getTime(), 0)
    : 0;

  // Burn rates — last 60 minutes across all deduped records
  let recentInput      = 0;
  let recentOutput     = 0;
  let recentOutputCost = 0;   // output-only cost: matches CCM display methodology
  let recentMessages   = 0;
  for (const r of deduped) {
    if (r.timestamp >= hourAgo) {
      if (!r.isUserMessage) {
        recentInput      += r.inputTokens;
        recentOutput     += r.outputTokens;
        recentOutputCost += r.outputTokens * getPrice(r.model).output;
      } else {
        recentMessages++;
      }
    }
  }
  const burnRate    = (recentInput + recentOutput) / 60;  // output-dominant tokens/min
  const msgBurnRate = recentMessages / 60;                // messages/min
  const costRate    = recentOutputCost / 60;              // $/min output-only (matches CCM)

  const msgLimit = Math.round(45 * (tokenLimit / 44000));

  const tokenPct = tokenLimit > 0
    ? Math.round((tokensUsed / tokenLimit) * 1000) / 10 : 0;
  const msgPct = msgLimit > 0
    ? Math.round((messagesUsed / msgLimit) * 1000) / 10 : 0;

  const costUsed = activeBlock ? activeBlock.totalCost : 0;

  let exhaustionTime = null;
  if (burnRate > 0 && tokensUsed < tokenLimit) {
    const minutesLeft = (tokenLimit - tokensUsed) / burnRate;
    exhaustionTime = new Date(now.getTime() + minutesLeft * 60000);
  }

  const models = Object.entries(modelTokens)
    .filter(([name]) => name && name !== "<synthetic>")
    .map(([name, tokens]) => ({
      name,
      tokens,
      pct: tokensUsed > 0 ? Math.round((tokens / tokensUsed) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const isIdle  = activeBlock === null;
  const hasData = deduped.some(r => !r.isUserMessage);

  return {
    isIdle, hasData,
    tokensUsed, tokenLimit, tokenPct,
    messagesUsed, msgLimit, msgPct,
    sessionStart, sessionEnd, lastTs,
    burnRate, msgBurnRate,
    costUsed, costRate,
    windowRemainingMs,
    exhaustionTime,
    models,
  };
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

    // State persisted between refresh() calls so tick() can extrapolate.
    this._sessionEnd          = null;
    this._isIdle              = true;
    this._burnRate            = 0;
    this._msgBurnRate         = 0;
    this._tokensUsedAtRefresh = 0;
    this._msgUsedAtRefresh    = 0;
    this._tokenLimit          = 1;
    this._msgLimit            = 1;
    this._lastRefreshTs       = 0;
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

  fmt(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
    if (n >= 10_000)    return (n / 1_000).toFixed(1) + "K";
    if (n >= 1_000)     return n.toLocaleString();
    return String(Math.round(n));
  }

  ticks(limit) {
    return [0, 1, 2, 3, 4].map(i => this.fmt(Math.round(limit * i / 4)));
  }

  timeAgo(date) {
    if (!date) return "no data";
    const s = Math.round((Date.now() - date.getTime()) / 1000);
    if (s < 60)   return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    return Math.round(s / 3600) + "h ago";
  }

  fmtDuration(ms) {
    if (ms <= 0) return "0m";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h === 0 && m < 10) return `${m}m ${s}s`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
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

  /**
   * Shorten model string for display.
   * "claude-sonnet-4-5-20251101" → "Sonnet 4.5"
   * "claude-opus-4-20250514"     → "Opus 4"
   */
  shortModel(name) {
    if (!name) return "Unknown";
    const m = name.match(/^claude-(\w+)-(\d[\d-]*)/);
    if (m) {
      const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
      const parts  = m[2].split("-");
      const versionParts = [];
      for (const p of parts) {
        if (p.length >= 8 && /^\d+$/.test(p)) break;
        versionParts.push(p);
      }
      return `${family} ${versionParts.join(".")}`;
    }
    return name.slice(0, 18);
  }


  // ── Phase 1: Build DOM shell once ────────────────────────────────────────

  buildShell() {
    const el = this.contentEl;
    el.empty();
    const e = this.els;

    const root  = el.createDiv({ cls: "kos-burn-root" });
    const panel = root.createDiv({ cls: "kos-panel" });

    // Label row — no innerHTML, use DOM methods
    const labelRow  = panel.createDiv({ cls: "kos-label-row" });
    const labelLeft = labelRow.createDiv({ cls: "kos-label-left" });
    labelLeft.createSpan({ text: `$ TOKEN BURN · ${WINDOW_HOURS}H WINDOW  ` });
    labelLeft.createSpan({ cls: "kos-live-dot" });
    labelLeft.createSpan({ text: " LIVE" });
    e.lastPull = labelRow.createDiv({ cls: "kos-label-right" });

    // Token bar
    const tr = this.buildBarShell(panel, true);
    e.tokenPctEl = tr.pctEl; e.tokenFill = tr.fill; e.tokenHatch = tr.hatch;
    e.tokenTicks = tr.tickSpans; e.tokenUsed = tr.usedEl; e.tokenLimit = tr.limitEl;

    panel.createDiv({ cls: "kos-divider" });

    // Messages label + bar
    const msgLabel = panel.createDiv({ cls: "kos-row-label" });
    msgLabel.textContent = `$ MESSAGES · ${WINDOW_HOURS}H WINDOW`;
    const mr = this.buildBarShell(panel, false);
    e.msgPctEl = mr.pctEl; e.msgFill = mr.fill; e.msgHatch = mr.hatch;
    e.msgTicks = mr.tickSpans; e.msgUsed = mr.usedEl; e.msgLimit = mr.limitEl;

    panel.createDiv({ cls: "kos-divider" });

    // Stats row
    const statsRow = panel.createDiv({ cls: "kos-stats-row" });

    const burn = this.buildStatShell(statsRow);
    burn.label.textContent = "BURN RATE";
    e.burnValue = burn.value; e.burnSub = burn.sub;

    const cost = this.buildStatShell(statsRow);
    cost.label.textContent = "API COST RATE";
    e.costValue = cost.value; e.costSub = cost.sub;

    const reset = this.buildStatShell(statsRow);
    reset.label.textContent = "RESETS IN";
    e.resetValue = reset.value; e.resetSub = reset.sub;

    const model = this.buildStatShell(statsRow);
    model.label.textContent = "MODEL";
    e.modelValue = model.value; e.modelSub = model.sub;

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
    const usedEl     = countBlock.createSpan({
      cls: "kos-count-used" + (big ? "" : " kos-small"), text: "—",
    });
    const limitEl = countBlock.createSpan({ cls: "kos-count-limit", text: "/ —" });

    return { pctEl, fill, hatch, tickSpans, usedEl, limitEl };
  }

  buildStatShell(parent) {
    const cell  = parent.createDiv({ cls: "kos-stat" });
    const label = cell.createDiv({ cls: "kos-stat-label" });
    const value = cell.createDiv({ cls: "kos-stat-value", text: "—" });
    const sub   = cell.createDiv({ cls: "kos-stat-sub",   text: "" });
    return { label, value, sub };
  }


  // ── Phase 2: Full data refresh (every N seconds) ─────────────────────────

  refresh() {
    const s       = this.plugin.settings;
    const records = readAllRecords(s.projectFilter || "");
    const tokenLimit = s.manualLimit > 0
      ? s.manualLimit
      : detectTokenLimit(records, s.fallbackLimit);
    const u = computeUsage(records, tokenLimit);
    const overrideEnd = parseResetOverride(s.resetTimeOverride || "");

    // Persist state for tick() extrapolation
    this._sessionEnd          = overrideEnd || (u.isIdle ? null : u.sessionEnd);
    this._isIdle              = u.isIdle;
    this._burnRate            = u.burnRate;
    this._msgBurnRate         = u.msgBurnRate;
    this._tokensUsedAtRefresh = u.tokensUsed;
    this._msgUsedAtRefresh    = u.messagesUsed;
    this._tokenLimit          = u.tokenLimit;
    this._msgLimit            = u.msgLimit;
    this._lastRefreshTs       = Date.now();

    const e = this.els;

    if (u.isIdle) {
      e.lastPull.textContent = "no active session";
      this.updateBar({
        pctEl: e.tokenPctEl, fill: e.tokenFill, hatch: e.tokenHatch,
        tickSpans: e.tokenTicks, usedEl: e.tokenUsed, limitEl: e.tokenLimit,
        pct: 0, used: "0", limit: this.fmt(tokenLimit), ticks: this.ticks(tokenLimit),
      });
      this.updateBar({
        pctEl: e.msgPctEl, fill: e.msgFill, hatch: e.msgHatch,
        tickSpans: e.msgTicks, usedEl: e.msgUsed, limitEl: e.msgLimit,
        pct: 0, used: "0", limit: String(u.msgLimit), ticks: this.ticks(u.msgLimit),
      });
      e.burnValue.textContent  = "0.0 tokens/min";
      e.burnSub.textContent    = "—";
      e.costValue.textContent  = "$0.0000 /min";
      e.costSub.textContent    = "$0.000 used via API";
      e.resetValue.textContent = "—";
      e.resetSub.textContent   = "session expired";
      e.modelValue.textContent = "—";
      e.modelSub.textContent   = "";
      e.errorEl.style.display  = "none";
      return;
    }

    e.lastPull.textContent = "last pull " + this.timeAgo(u.lastTs);

    this.updateBar({
      pctEl: e.tokenPctEl, fill: e.tokenFill, hatch: e.tokenHatch,
      tickSpans: e.tokenTicks, usedEl: e.tokenUsed, limitEl: e.tokenLimit,
      pct: u.tokenPct, used: this.fmt(u.tokensUsed),
      limit: this.fmt(u.tokenLimit), ticks: this.ticks(u.tokenLimit),
    });

    this.updateBar({
      pctEl: e.msgPctEl, fill: e.msgFill, hatch: e.msgHatch,
      tickSpans: e.msgTicks, usedEl: e.msgUsed, limitEl: e.msgLimit,
      pct: u.msgPct, used: String(u.messagesUsed),
      limit: String(u.msgLimit), ticks: this.ticks(u.msgLimit),
    });

    e.burnValue.textContent = u.burnRate.toFixed(1) + " tokens/min";
    e.burnSub.textContent   = u.exhaustionTime
      ? "runs out ~" + this.fmtTime(u.exhaustionTime)
      : "—";

    e.costValue.textContent = "$" + u.costRate.toFixed(4) + " /min";
    e.costSub.textContent   = "$" + u.costUsed.toFixed(3) + " used via API";

    const effectiveEnd = overrideEnd || u.sessionEnd;
    e.resetSub.textContent = effectiveEnd
      ? "@ " + this.fmtTime(effectiveEnd) + (overrideEnd ? " · manual" : "")
      : "no active window";

    const topModel = u.models.length > 0 ? u.models[0] : null;
    e.modelValue.textContent = topModel ? this.shortModel(topModel.name) : "—";
    e.modelSub.textContent   = u.models.length > 1
      ? u.models.map(m => this.shortModel(m.name) + " " + m.pct + "%").join(" · ")
      : (topModel ? topModel.pct + "%" : "");

    e.errorEl.style.display = u.hasData ? "none" : "block";
    e.errorEl.textContent   = "No session data — run Claude Code at least once.";
  }

  updateBar({ pctEl, fill, hatch, tickSpans, usedEl, limitEl, pct, used, limit, ticks }) {
    pctEl.textContent   = String(pct);
    fill.style.width    = Math.min(pct, 100) + "%";
    hatch.style.width   = Math.max(100 - pct, 0) + "%";
    usedEl.textContent  = used;
    limitEl.textContent = "/ " + limit;
    if (ticks) ticks.forEach((t, i) => { tickSpans[i].textContent = t; });
  }

  /**
   * Runs every second.
   * 1. Updates the countdown timer.
   * 2. Extrapolates token/message percentages from burnRate so bars
   *    advance smoothly between full refreshes instead of jumping.
   */
  tick() {
    if (!this.els.resetValue) return;

    // Countdown
    if (!this._sessionEnd) {
      this.els.resetValue.textContent = "—";
    } else {
      const remaining = Math.max(this._sessionEnd.getTime() - Date.now(), 0);
      this.els.resetValue.textContent = "~" + this.fmtDuration(remaining);
    }

    // No extrapolation needed when idle or burn rate is zero
    if (this._isIdle || this._burnRate <= 0) return;

    const elapsedMin = (Date.now() - this._lastRefreshTs) / 60000;

    // Token bar
    const extraTokens   = this._tokensUsedAtRefresh + this._burnRate * elapsedMin;
    const extraTokenPct = this._tokenLimit > 0
      ? Math.round((extraTokens / this._tokenLimit) * 1000) / 10
      : 0;
    this.els.tokenPctEl.textContent = String(extraTokenPct);
    this.els.tokenFill.style.width  = Math.min(extraTokenPct, 100) + "%";
    this.els.tokenHatch.style.width = Math.max(100 - extraTokenPct, 0) + "%";

    // Message bar (only when there's a measurable message rate)
    if (this._msgBurnRate > 0) {
      const extraMsgs   = this._msgUsedAtRefresh + this._msgBurnRate * elapsedMin;
      const extraMsgPct = this._msgLimit > 0
        ? Math.round((extraMsgs / this._msgLimit) * 1000) / 10
        : 0;
      this.els.msgPctEl.textContent = String(extraMsgPct);
      this.els.msgFill.style.width  = Math.min(extraMsgPct, 100) + "%";
      this.els.msgHatch.style.width = Math.max(100 - extraMsgPct, 0) + "%";
    }
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

    new Setting(containerEl)
      .setName("Token limit (manual override)")
      .setDesc("Set to 0 for auto-detection from your session history.")
      .addText(text => text
        .setPlaceholder("0 = auto")
        .setValue(String(this.plugin.settings.manualLimit))
        .onChange(async (v) => {
          this.plugin.settings.manualLimit = parseInt(v) || 0;
          await this.plugin.saveSettings();
          this._refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("Fallback limit")
      .setDesc("Used when auto-detection has no data yet (default: 44000).")
      .addText(text => text
        .setPlaceholder("44000")
        .setValue(String(this.plugin.settings.fallbackLimit))
        .onChange(async (v) => {
          this.plugin.settings.fallbackLimit = parseInt(v) || 44000;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Refresh interval (seconds)")
      .setDesc("How often to re-read session logs (default 5s). Lower = more accurate percentage. At 5s and 2400 tokens/min burn rate, max error is ~0.07% on a 300K limit. File cache keeps CPU impact minimal.")
      .addText(text => text
        .setPlaceholder("30")
        .setValue(String(this.plugin.settings.refreshSecs))
        .onChange(async (v) => {
          this.plugin.settings.refreshSecs = parseInt(v) || 30;
          await this.plugin.saveSettings();
          // Immediately apply new interval to all open views
          this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE)
            .forEach(l => l.view instanceof BurnBarView && l.view.startTimers());
        })
      );

    new Setting(containerEl)
      .setName("Timezone")
      .setDesc("IANA timezone for reset predictions (e.g. America/New_York).")
      .addText(text => text
        .setPlaceholder("America/New_York")
        .setValue(this.plugin.settings.timezone)
        .onChange(async (v) => {
          this.plugin.settings.timezone = v || "America/New_York";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Reset time override")
      .setDesc(
        "The burn bar infers your reset time from local session logs. " +
        "If you pause Claude Code for more than an hour mid-window, the log parser " +
        "may start a new session block and show an incorrect (too long) countdown. " +
        "To fix it: check the real reset time on claude.ai, then enter it here " +
        "(e.g. 14:45 or 2:45 PM, in your local time). " +
        "The override is active until that time passes — after that the bar " +
        "reverts to log-derived values automatically. " +
        "Clear this field once your window has reset."
      )
      .addText(text => text
        .setPlaceholder("e.g. 14:45 or 2:45 PM")
        .setValue(this.plugin.settings.resetTimeOverride || "")
        .onChange(async (v) => {
          this.plugin.settings.resetTimeOverride = v.trim();
          await this.plugin.saveSettings();
          this._refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("Project filter")
      .setDesc("By default all Claude Code projects count toward the burn bar. To limit it to one project, enter part of your working directory name. Example: if you work in /home/you/my-project, enter 'my-project'. Leave blank to track all projects.")
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
      .setDesc("Automatically show the burn bar when you open this vault.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoOpen)
        .onChange(async (v) => {
          this.plugin.settings.autoOpen = v;
          await this.plugin.saveSettings();
        })
      );
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
  }

  onunload() {
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
  getPrice,
  recordCost,
  parseFile,
  deduplicateRecords,
  buildSessionBlocks,
  detectTokenLimit,
  computeUsage,
  readAllRecords,
  BurnBarView,
};

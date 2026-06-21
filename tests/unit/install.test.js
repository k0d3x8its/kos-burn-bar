// Install / uninstall test suite.
// Each test uses its own tmpdir as the claudeDir override so we never touch ~/.claude.
// A minimal fake kos-burn-tap.sh is written to the tmpdir too (as the tapSrc arg) so
// the install logic can copy it in without needing the real repo file.

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const { enableCapture, disableCapture } = require("../../main.js")._test;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Write a minimal fake tap script (content doesn't matter for install tests).
function writeFakeTap(dir) {
  const p = path.join(dir, "fake-tap.sh");
  fs.writeFileSync(p, "#!/usr/bin/env bash\necho fake\n", "utf8");
  return p;
}

function writeSettings(dir, obj) {
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(obj), "utf8");
}

function readSettings(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
}

let dir, tapSrc;
beforeEach(() => {
  dir    = fs.mkdtempSync(path.join(os.tmpdir(), "kos-install-"));
  tapSrc = writeFakeTap(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Win32 guard ───────────────────────────────────────────────────────────────

describe("win32 guard", () => {
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  afterEach(() => {
    // Restore platform after each test.
    Object.defineProperty(process, "platform", origPlatform);
  });

  test("enableCapture returns win32:true on Windows and does NOT write files", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    writeSettings(dir, {});
    const result = enableCapture(dir, tapSrc);
    expect(result.ok).toBe(false);
    expect(result.win32).toBe(true);
    expect(result.message).toMatch(/Windows/i);
    // settings.json should be unchanged (still the empty object we wrote).
    expect(readSettings(dir)).toEqual({});
  });

  test("disableCapture returns win32:true on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const result = disableCapture(dir);
    expect(result.ok).toBe(false);
    expect(result.win32).toBe(true);
  });
});

// ── Symlink detection ─────────────────────────────────────────────────────────

describe("symlink detection", () => {
  test("enableCapture does NOT auto-write when settings.json is a symlink", () => {
    // Create the real file in a sub-dir and symlink it into dir.
    const real = path.join(dir, "real-settings.json");
    fs.writeFileSync(real, JSON.stringify({ statusLine: { command: "old-cmd" } }));
    const link = path.join(dir, "settings.json");
    fs.symlinkSync(real, link);

    const result = enableCapture(dir, tapSrc);
    expect(result.ok).toBe(false);
    expect(result.symlink).toBe(true);
    // Result must carry tapDst and tapCmd so the UI can build the guide.
    expect(result.tapDst).toMatch(/kos-burn-tap\.sh/i);
    expect(result.tapCmd).toMatch(/bash.*kos-burn-tap\.sh/i);
    // Tap script must have been installed even though settings.json was not written.
    expect(fs.existsSync(result.tapDst)).toBe(true);
    // The real file behind the symlink must be untouched.
    const after = JSON.parse(fs.readFileSync(real, "utf8"));
    expect(after.statusLine.command).toBe("old-cmd");
  });

  test("disableCapture returns symlink:true and instructions when settings is symlink", () => {
    const real = path.join(dir, "real-settings.json");
    fs.writeFileSync(real, JSON.stringify({}));
    fs.symlinkSync(real, path.join(dir, "settings.json"));
    const result = disableCapture(dir);
    expect(result.ok).toBe(false);
    expect(result.symlink).toBe(true);
    expect(result.message).toMatch(/symlink/i);
  });
});

// ── Plain-file auto-edit + backup ─────────────────────────────────────────────

describe("plain-file install", () => {
  test("installs tap, writes prev, creates backup, and updates statusLine.command", () => {
    writeSettings(dir, { statusLine: { command: "original-cmd", type: "above" } });

    const result = enableCapture(dir, tapSrc);
    expect(result.ok).toBe(true);
    expect(result.noOp).toBeUndefined();

    // settings.json should have statusLine.command pointing at the tap.
    const s = readSettings(dir);
    const tapDst = path.join(dir, "kos-burn-tap.sh");
    expect(s.statusLine.command).toBe("bash " + tapDst);
    // Existing keys (type) must be preserved.
    expect(s.statusLine.type).toBe("above");

    // Backup should exist.
    expect(fs.existsSync(path.join(dir, "settings.json.kos-bak"))).toBe(true);
    const bak = JSON.parse(fs.readFileSync(path.join(dir, "settings.json.kos-bak"), "utf8"));
    expect(bak.statusLine.command).toBe("original-cmd");

    // Prev file holds the original command verbatim.
    const prev = fs.readFileSync(path.join(dir, "kos-burn-bar-prev"), "utf8");
    expect(prev).toBe("original-cmd");

    // Tap script should exist and be executable.
    expect(fs.existsSync(tapDst)).toBe(true);
  });

  test("works when settings.json does not exist yet (first-time user)", () => {
    // No settings.json — install should succeed and create it.
    const result = enableCapture(dir, tapSrc);
    expect(result.ok).toBe(true);
    const tapDst = path.join(dir, "kos-burn-tap.sh");
    const s = readSettings(dir);
    expect(s.statusLine.command).toBe("bash " + tapDst);
  });

  test("prev file is empty when there was no previous statusLine.command", () => {
    writeSettings(dir, { someOtherKey: true });
    enableCapture(dir, tapSrc);
    const prev = fs.readFileSync(path.join(dir, "kos-burn-bar-prev"), "utf8");
    expect(prev).toBe("");
  });
});

// ── Backup-only-if-absent ─────────────────────────────────────────────────────

describe("backup only if absent", () => {
  test("does not overwrite an existing .kos-bak", () => {
    // Simulate a prior backup that contains the true original.
    const trueOriginal = { statusLine: { command: "true-original" } };
    fs.writeFileSync(
      path.join(dir, "settings.json.kos-bak"),
      JSON.stringify(trueOriginal),
      "utf8"
    );
    // Current settings already reflect a previous install (or any intermediate state).
    writeSettings(dir, { statusLine: { command: "some-other-state" } });

    enableCapture(dir, tapSrc);

    // The existing .kos-bak must not be overwritten.
    const bak = JSON.parse(fs.readFileSync(path.join(dir, "settings.json.kos-bak"), "utf8"));
    expect(bak.statusLine.command).toBe("true-original");
  });
});

// ── Marker idempotency ────────────────────────────────────────────────────────

describe("marker idempotency", () => {
  test("no-op when tap marker already present in statusLine.command", () => {
    const tapDst = path.join(dir, "kos-burn-tap.sh");
    // Simulate already-installed: settings has the tap command.
    writeSettings(dir, { statusLine: { command: "bash " + tapDst } });
    // Pre-write a backup so we can verify it's NOT re-written.
    fs.writeFileSync(
      path.join(dir, "settings.json.kos-bak"),
      JSON.stringify({ statusLine: { command: "original" } }),
      "utf8"
    );

    const result = enableCapture(dir, tapSrc);
    expect(result.ok).toBe(true);
    expect(result.noOp).toBe(true);

    // Backup unchanged.
    const bak = JSON.parse(fs.readFileSync(path.join(dir, "settings.json.kos-bak"), "utf8"));
    expect(bak.statusLine.command).toBe("original");

    // settings.json unchanged.
    const s = readSettings(dir);
    expect(s.statusLine.command).toBe("bash " + tapDst);
  });
});

// ── Disable — restore from .kos-bak ─────────────────────────────────────────

describe("disable: restore from .kos-bak", () => {
  test("restores settings.json from backup and deletes installed files", () => {
    const original = { statusLine: { command: "original-cmd" }, other: 1 };
    // Write backup (the gold-standard pre-tap state).
    fs.writeFileSync(path.join(dir, "settings.json.kos-bak"), JSON.stringify(original));
    // Write current (the tapped) settings.
    const tapDst = path.join(dir, "kos-burn-tap.sh");
    writeSettings(dir, { statusLine: { command: "bash " + tapDst } });
    // Create the other files that Disable should clean up.
    fs.writeFileSync(path.join(dir, "kos-burn-bar-prev"),       "original-cmd");
    fs.writeFileSync(path.join(dir, "kos-burn-bar-state.json"), "{}");
    fs.writeFileSync(tapDst, "#!/bin/bash\n");

    const result = disableCapture(dir);
    expect(result.ok).toBe(true);

    // settings.json is now the original.
    const s = readSettings(dir);
    expect(s.statusLine.command).toBe("original-cmd");
    expect(s.other).toBe(1);

    // All installed files should be gone.
    expect(fs.existsSync(tapDst)).toBe(false);
    expect(fs.existsSync(path.join(dir, "kos-burn-bar-prev"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "kos-burn-bar-state.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "settings.json.kos-bak"))).toBe(false);
  });
});

// ── Disable — prev-file fallback (no .kos-bak) ───────────────────────────────

describe("disable: prev-file fallback when .kos-bak missing", () => {
  test("reconstructs statusLine.command from prev file when .kos-bak is absent", () => {
    // No backup — only prev file.
    const tapDst = path.join(dir, "kos-burn-tap.sh");
    writeSettings(dir, { statusLine: { command: "bash " + tapDst } });
    fs.writeFileSync(path.join(dir, "kos-burn-bar-prev"), "my-original-cmd");

    const result = disableCapture(dir);
    expect(result.ok).toBe(true);

    const s = readSettings(dir);
    expect(s.statusLine.command).toBe("my-original-cmd");
  });

  test("removes statusLine.command entirely when prev file is empty", () => {
    const tapDst = path.join(dir, "kos-burn-tap.sh");
    writeSettings(dir, { statusLine: { command: "bash " + tapDst } });
    fs.writeFileSync(path.join(dir, "kos-burn-bar-prev"), "");

    const result = disableCapture(dir);
    expect(result.ok).toBe(true);

    const s = readSettings(dir);
    // statusLine should either be gone or have no command key.
    expect(s.statusLine).toBeUndefined();
  });

  test("removes statusLine.command but preserves other statusLine fields", () => {
    const tapDst = path.join(dir, "kos-burn-tap.sh");
    writeSettings(dir, { statusLine: { command: "bash " + tapDst, type: "above" } });
    fs.writeFileSync(path.join(dir, "kos-burn-bar-prev"), "");

    disableCapture(dir);

    const s = readSettings(dir);
    // type should survive; command should be gone.
    expect(s.statusLine).toBeDefined();
    expect(s.statusLine.type).toBe("above");
    expect(s.statusLine.command).toBeUndefined();
  });
});

// ── Round-trip: enable then disable ──────────────────────────────────────────

describe("round-trip: enable then disable", () => {
  test("settings.json is back to original after enable -> disable", () => {
    const original = { statusLine: { command: "my-statusline" }, debug: true };
    writeSettings(dir, original);

    enableCapture(dir, tapSrc);
    disableCapture(dir);

    const s = readSettings(dir);
    expect(s.statusLine.command).toBe("my-statusline");
    expect(s.debug).toBe(true);
  });
});

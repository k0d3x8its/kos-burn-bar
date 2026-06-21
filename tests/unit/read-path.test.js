// Read-path suite for the datasource pivot (server rate_limits via the tap).
// Covers: parse + extraction, keep-last-good on failure, --%/null on missing,
// independent window degradation, and the freshness thresholds.
const fs   = require("fs");
const os   = require("os");
const path = require("path");

const { readBurnState, burnFreshness, _resetBurnStateCache } =
  require("../../main.js")._test;

// Each test gets its own throwaway ~/.claude dir so the on-disk state file is
// isolated. The module-level keep-last-good cache is process-global, so we also
// reset it before every test.
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kos-burn-"));
  _resetBurnStateCache();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Write the state file the way the tap does: the FULL StatusLine JSON, verbatim.
function writeState(obj) {
  fs.writeFileSync(path.join(dir, "kos-burn-bar-state.json"), JSON.stringify(obj));
}

describe("readBurnState — extraction", () => {
  test("pulls both windows' used_percentage and resets_at", () => {
    writeState({
      rate_limits: {
        five_hour: { used_percentage: 42.5, resets_at: 1750000000 },
        seven_day: { used_percentage: 13.0, resets_at: 1750500000 },
      },
    });
    const s = readBurnState(dir);
    expect(s.fiveHour).toBe(42.5);
    expect(s.sevenDay).toBe(13.0);
    expect(s.fiveHourResetsAt).toBe(1750000000);
    expect(s.sevenDayResetsAt).toBe(1750500000);
    expect(typeof s.mtimeMs).toBe("number");
  });

  test("accepts an ISO-string resets_at unchanged", () => {
    writeState({
      rate_limits: { five_hour: { used_percentage: 5, resets_at: "2026-06-20T18:00:00Z" } },
    });
    expect(readBurnState(dir).fiveHourResetsAt).toBe("2026-06-20T18:00:00Z");
  });
});

describe("readBurnState — missing/null becomes null, never 0", () => {
  test("no state file at all -> empty (all null) state", () => {
    const s = readBurnState(dir);
    expect(s.fiveHour).toBeNull();
    expect(s.sevenDay).toBeNull();
    expect(s.mtimeMs).toBeNull();
  });

  test("file present but no rate_limits -> nulls (not 0)", () => {
    writeState({ some_other_field: true });
    const s = readBurnState(dir);
    expect(s.fiveHour).toBeNull();
    expect(s.sevenDay).toBeNull();
  });

  test("window present but used_percentage missing -> null, not 0", () => {
    writeState({ rate_limits: { five_hour: { resets_at: 123 } } });
    expect(readBurnState(dir).fiveHour).toBeNull();
  });

  test("a genuine 0 is preserved (not coerced to null)", () => {
    writeState({ rate_limits: { five_hour: { used_percentage: 0 } } });
    expect(readBurnState(dir).fiveHour).toBe(0);
  });
});

describe("readBurnState — windows degrade independently", () => {
  test("only five_hour present -> 5h number, weekly null", () => {
    writeState({ rate_limits: { five_hour: { used_percentage: 77 } } });
    const s = readBurnState(dir);
    expect(s.fiveHour).toBe(77);
    expect(s.sevenDay).toBeNull();
  });
});

describe("readBurnState — keep-last-good", () => {
  test("corrupt JSON after a good read returns the last good value", () => {
    writeState({ rate_limits: { five_hour: { used_percentage: 50 } } });
    expect(readBurnState(dir).fiveHour).toBe(50);

    // Corrupt the file (simulate a torn read).
    fs.writeFileSync(path.join(dir, "kos-burn-bar-state.json"), "{ not json");
    expect(readBurnState(dir).fiveHour).toBe(50);
  });

  test("a present-but-empty payload reports --% (null), but does not clobber the cache", () => {
    writeState({ rate_limits: { five_hour: { used_percentage: 60 } } });
    expect(readBurnState(dir).fiveHour).toBe(60);

    // A payload with no rate_limits means "no data right now" -> show --% (null),
    // NOT a stale 60. Distinct from a torn read (which keeps last-good). Per Q7.
    writeState({ no_rate_limits: true });
    expect(readBurnState(dir).fiveHour).toBeNull();

    // ...but the cache underneath wasn't overwritten by those nulls: a later torn
    // read still recovers the genuine last-good value.
    fs.writeFileSync(path.join(dir, "kos-burn-bar-state.json"), "{ torn");
    expect(readBurnState(dir).fiveHour).toBe(60);
  });
});

describe("burnFreshness — thresholds", () => {
  const now = 10_000_000_000; // fixed reference
  test("null mtime -> stale", () => {
    expect(burnFreshness(null, now)).toBe("stale");
  });
  test("<60s old -> live", () => {
    expect(burnFreshness(now - 30 * 1000, now)).toBe("live");
  });
  test("between 60s and 5h -> recent", () => {
    expect(burnFreshness(now - 10 * 60 * 1000, now)).toBe("recent");
  });
  test(">5h old -> stale", () => {
    expect(burnFreshness(now - 6 * 60 * 60 * 1000, now)).toBe("stale");
  });
});

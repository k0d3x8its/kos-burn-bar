const { BurnBarView } = require("../../main.js")._test;

function makeView(tz = "UTC") {
  const plugin = { settings: { timezone: tz } };
  return new BurnBarView({}, plugin);
}

describe("BurnBarView.fmt", () => {
  let v;
  beforeEach(() => { v = makeView(); });

  test("formats millions to 2 decimal places", () => {
    expect(v.fmt(1_500_000)).toBe("1.50M");
    expect(v.fmt(2_000_000)).toBe("2.00M");
  });

  test("formats tens of thousands to 1 decimal K", () => {
    expect(v.fmt(10_000)).toBe("10.0K");
    expect(v.fmt(310_200)).toBe("310.2K");
  });

  test("formats 1000-9999 with toLocaleString (no K)", () => {
    const result = v.fmt(1234);
    expect(result).not.toContain("K");
    expect(result).not.toContain("M");
    // value must contain the digits 1234 in some locale format
    expect(result.replace(/[,. ]/g, "")).toBe("1234");
  });

  test("formats sub-1000 as plain integer", () => {
    expect(v.fmt(42)).toBe("42");
    expect(v.fmt(999)).toBe("999");
    expect(v.fmt(0)).toBe("0");
  });

  test("rounds sub-1000 values", () => {
    expect(v.fmt(42.7)).toBe("43");
  });
});

describe("BurnBarView.fmtDuration", () => {
  let v;
  beforeEach(() => { v = makeView(); });

  test("zero ms returns '0m'", () => {
    expect(v.fmtDuration(0)).toBe("0m");
  });

  test("negative ms returns '0m'", () => {
    expect(v.fmtDuration(-5000)).toBe("0m");
  });

  test("under 10 minutes shows mm ss format", () => {
    expect(v.fmtDuration(5 * 60000 + 30000)).toBe("5m 30s");
    expect(v.fmtDuration(9 * 60000 + 59000)).toBe("9m 59s");
  });

  test("0 minutes 45 seconds shows '0m 45s'", () => {
    expect(v.fmtDuration(45000)).toBe("0m 45s");
  });

  test("10+ minutes shows mm only", () => {
    expect(v.fmtDuration(15 * 60000)).toBe("15m");
    expect(v.fmtDuration(59 * 60000)).toBe("59m");
  });

  test("hours show hh mm format", () => {
    expect(v.fmtDuration(2 * 3600000 + 15 * 60000)).toBe("2h 15m");
    expect(v.fmtDuration(1 * 3600000 + 0 * 60000)).toBe("1h 0m");
  });
});

describe("BurnBarView.shortModel", () => {
  let v;
  beforeEach(() => { v = makeView(); });

  test("sonnet with minor version", () => {
    expect(v.shortModel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
  });

  test("haiku with date suffix stripped", () => {
    expect(v.shortModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  test("opus with date suffix stripped", () => {
    expect(v.shortModel("claude-opus-4-20250514")).toBe("Opus 4");
  });

  test("null returns 'Unknown'", () => {
    expect(v.shortModel(null)).toBe("Unknown");
  });

  test("unrecognized model truncated to 18 chars", () => {
    const result = v.shortModel("some-completely-unknown-model-name");
    expect(result.length).toBeLessThanOrEqual(18);
  });

  test("capitalizes family name", () => {
    expect(v.shortModel("claude-sonnet-4-6")).toMatch(/^Sonnet/);
  });
});

describe("BurnBarView.timeAgo", () => {
  let v;
  beforeEach(() => { v = makeView(); });

  test("null returns 'no data'", () => {
    expect(v.timeAgo(null)).toBe("no data");
  });

  test("recent seconds", () => {
    const d = new Date(Date.now() - 30000);
    expect(v.timeAgo(d)).toMatch(/^\d+s ago$/);
  });

  test("minutes ago", () => {
    const d = new Date(Date.now() - 5 * 60000);
    expect(v.timeAgo(d)).toBe("5m ago");
  });

  test("hours ago", () => {
    const d = new Date(Date.now() - 2 * 3600000);
    expect(v.timeAgo(d)).toBe("2h ago");
  });
});

describe("BurnBarView.fmtTime", () => {
  let v;

  test("formats Date as locale time string in UTC", () => {
    v = makeView("UTC");
    const d = new Date("2024-01-01T14:30:00Z");
    const result = v.fmtTime(d);
    expect(typeof result).toBe("string");
    expect(result).toMatch(/2:30/);
  });

  test("returns em-dash for null", () => {
    v = makeView("UTC");
    expect(v.fmtTime(null)).toBe("—");
  });

  test("falls back gracefully on invalid timezone", () => {
    v = makeView("Not/ATimezone");
    const d = new Date("2024-01-01T14:30:00Z");
    const result = v.fmtTime(d);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("BurnBarView.ticks", () => {
  let v;
  beforeEach(() => { v = makeView(); });

  test("returns 5 tick labels", () => {
    expect(v.ticks(100000)).toHaveLength(5);
  });

  test("first tick is 0", () => {
    expect(v.ticks(100000)[0]).toBe("0");
  });

  test("last tick equals formatted limit", () => {
    const ticks = v.ticks(100000);
    expect(ticks[4]).toBe(v.fmt(100000));
  });
});

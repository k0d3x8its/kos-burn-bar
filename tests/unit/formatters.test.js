const { BurnBarView } = require("../../main.js")._test;

function makeView(tz = "UTC") {
  const plugin = { settings: { timezone: tz } };
  return new BurnBarView({}, plugin);
}


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


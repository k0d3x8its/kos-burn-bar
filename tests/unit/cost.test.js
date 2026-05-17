const { getPrice, recordCost } = require("../../main.js")._test;

describe("getPrice", () => {
  test("opus model returns opus pricing", () => {
    const p = getPrice("claude-opus-4-20250514");
    expect(p.output).toBe(75 / 1e6);
    expect(p.cacheWrite).toBe(18.75 / 1e6);
  });

  test("haiku model returns haiku pricing", () => {
    const p = getPrice("claude-haiku-4-5-20251001");
    expect(p.output).toBe(4 / 1e6);
    expect(p.cacheRead).toBe(0.08 / 1e6);
  });

  test("sonnet model returns sonnet pricing", () => {
    const p = getPrice("claude-sonnet-4-6");
    expect(p.output).toBe(15 / 1e6);
    expect(p.cacheWrite).toBe(3.75 / 1e6);
  });

  test("unknown model falls back to sonnet pricing", () => {
    const p = getPrice("some-unknown-model");
    expect(p.output).toBe(15 / 1e6);
  });

  test("null model returns default pricing", () => {
    const p = getPrice(null);
    expect(p.output).toBe(15 / 1e6);
  });

  test("undefined model returns default pricing", () => {
    const p = getPrice(undefined);
    expect(p.output).toBe(15 / 1e6);
  });
});

describe("recordCost", () => {
  test("calculates cost from all four token types", () => {
    const r = {
      model: "claude-sonnet-4-6",
      inputTokens:       1000,
      cacheCreateTokens: 1000,
      cacheReadTokens:   1000,
      outputTokens:      1000,
    };
    // Sonnet: input $3/1M, cacheWrite $3.75/1M, cacheRead $0.30/1M, output $15/1M
    const expected = (1000 * 3 + 1000 * 3.75 + 1000 * 0.30 + 1000 * 15) / 1e6;
    expect(recordCost(r)).toBeCloseTo(expected, 10);
  });

  test("all-zero record has zero cost", () => {
    const r = { model: null, inputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
    expect(recordCost(r)).toBe(0);
  });

  test("opus output tokens cost 5x more than sonnet", () => {
    const base = { inputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, outputTokens: 1000 };
    const opus   = recordCost({ ...base, model: "claude-opus-4" });
    const sonnet = recordCost({ ...base, model: "claude-sonnet-4-6" });
    expect(opus / sonnet).toBeCloseTo(5, 5);
  });

  test("haiku costs less than sonnet for same tokens", () => {
    const base = { inputTokens: 1000, cacheCreateTokens: 1000, cacheReadTokens: 1000, outputTokens: 1000 };
    expect(recordCost({ ...base, model: "claude-haiku-4-5" }))
      .toBeLessThan(recordCost({ ...base, model: "claude-sonnet-4-6" }));
  });

  test("cache_read is cheapest token type per unit (sonnet)", () => {
    const p = getPrice("claude-sonnet-4-6");
    expect(p.cacheRead).toBeLessThan(p.input);
    expect(p.cacheRead).toBeLessThan(p.cacheWrite);
    expect(p.cacheRead).toBeLessThan(p.output);
  });
});

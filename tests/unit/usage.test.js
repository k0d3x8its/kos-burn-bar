const { computeUsage } = require("../../main.js")._test;

function asst(tsMs, opts = {}) {
  return {
    uuid:              opts.uuid || null,
    timestamp:         new Date(tsMs),
    inputTokens:       opts.inputTokens  ?? 100,
    outputTokens:      opts.outputTokens ?? 50,
    cacheCreateTokens: opts.cacheCreate  ?? 0,
    cacheReadTokens:   opts.cacheRead    ?? 0,
    isUserMessage:     false,
    model:             opts.model || "claude-sonnet-4-6",
  };
}

function user(tsMs) {
  return {
    uuid: null, timestamp: new Date(tsMs),
    inputTokens: 0, outputTokens: 0,
    cacheCreateTokens: 0, cacheReadTokens: 0,
    isUserMessage: true, model: null,
  };
}

describe("computeUsage", () => {
  test("hasData false when no assistant records", () => {
    const u = computeUsage([user(Date.now() - 5000)], 44000);
    expect(u.hasData).toBe(false);
  });

  test("isIdle true when no active block", () => {
    // Record 6h ago → block endTime = 6h ago + 5h = 1h ago → expired
    const u = computeUsage([asst(Date.now() - 6 * 3600000)], 44000);
    expect(u.isIdle).toBe(true);
  });

  test("isIdle false when active block exists", () => {
    const u = computeUsage([asst(Date.now() - 30 * 60000)], 44000);
    expect(u.isIdle).toBe(false);
  });

  test("hasData true when assistant record present", () => {
    const u = computeUsage([asst(Date.now() - 30 * 60000)], 44000);
    expect(u.hasData).toBe(true);
  });

  test("tokenPct can exceed 100 (no cap)", () => {
    const u = computeUsage([asst(Date.now() - 30 * 60000, { inputTokens: 30000, outputTokens: 30000 })], 44000);
    // 60000 / 44000 ≈ 136.4%
    expect(u.tokenPct).toBeGreaterThan(100);
  });

  test("tokensUsed = totalInput + totalOutput of active block", () => {
    const u = computeUsage([asst(Date.now() - 30 * 60000, { inputTokens: 1000, outputTokens: 500 })], 44000);
    expect(u.tokensUsed).toBe(1500);
  });

  test("burnRate computed from last 60 min only", () => {
    const now = Date.now();
    // r1 in last 60 min, r2 just beyond 60 min (but same session block — gap < 1h)
    const r1 = asst(now - 30 * 60000, { inputTokens: 3000, outputTokens: 3000 });
    const r2 = asst(now - 61 * 60000, { inputTokens: 9999, outputTokens: 9999 }); // outside window
    const u = computeUsage([r1, r2], 44000);
    // Only r1 counted: (3000+3000)/60 = 100
    expect(u.burnRate).toBeCloseTo(100, 0);
  });

  test("costUsed includes all four tiered token types", () => {
    const r = asst(Date.now() - 30 * 60000, {
      inputTokens: 1000, outputTokens: 1000,
      cacheCreate: 1000, cacheRead: 1000,
      model: "claude-sonnet-4-6",
    });
    const u = computeUsage([r], 44000);
    // Sonnet: (1000*3 + 1000*3.75 + 1000*0.30 + 1000*15) / 1e6
    const expected = (1000 * (3 + 3.75 + 0.30 + 15)) / 1e6;
    expect(u.costUsed).toBeCloseTo(expected, 10);
  });

  test("costRate is output-only $/min", () => {
    const now = Date.now();
    // 1000 output tokens in last 60 min, sonnet
    const r = asst(now - 30 * 60000, { inputTokens: 0, outputTokens: 1000, cacheCreate: 0, cacheRead: 0 });
    const u = computeUsage([r], 44000);
    // costRate = (1000 * 15/1e6) / 60
    expect(u.costRate).toBeCloseTo((1000 * 15 / 1e6) / 60, 10);
  });

  test("msgLimit scales proportionally with tokenLimit", () => {
    const u = computeUsage([asst(Date.now() - 30 * 60000)], 88000);
    // msgLimit = round(45 * (88000/44000)) = 90
    expect(u.msgLimit).toBe(90);
  });

  test("messagesUsed counts user records in active block", () => {
    const base = Date.now() - 30 * 60000;
    const records = [
      asst(base),
      user(base + 60000),      // 1m after block start — inside
      user(base + 5 * 60000),  // 5m after start — inside
    ];
    const u = computeUsage(records, 44000);
    expect(u.messagesUsed).toBe(2);
  });

  test("exhaustionTime set when tokens below limit", () => {
    const u = computeUsage([asst(Date.now() - 30 * 60000, { inputTokens: 100, outputTokens: 100 })], 44000);
    expect(u.exhaustionTime).not.toBeNull();
    expect(u.exhaustionTime).toBeInstanceOf(Date);
  });

  test("exhaustionTime null when tokensUsed >= tokenLimit", () => {
    const u = computeUsage([asst(Date.now() - 30 * 60000, { inputTokens: 30000, outputTokens: 30000 })], 44000);
    // 60000 > 44000
    expect(u.exhaustionTime).toBeNull();
  });

  test("models array sorted by token count descending", () => {
    const base = Date.now() - 30 * 60000;
    const records = [
      asst(base,              { model: "claude-haiku-4-5",  inputTokens: 10, outputTokens: 10 }),
      asst(base + 5 * 60000, { model: "claude-sonnet-4-6", inputTokens: 200, outputTokens: 200 }),
    ];
    const u = computeUsage(records, 44000);
    expect(u.models[0].name).toBe("claude-sonnet-4-6");
    expect(u.models[1].name).toBe("claude-haiku-4-5");
  });

  test("model pct sums to 100 for single model", () => {
    const u = computeUsage([asst(Date.now() - 30 * 60000)], 44000);
    expect(u.models[0].pct).toBe(100);
  });

  test("windowRemainingMs positive when session active", () => {
    const u = computeUsage([asst(Date.now() - 30 * 60000)], 44000);
    expect(u.windowRemainingMs).toBeGreaterThan(0);
  });

  test("sessionEnd is approximately startTime + 5h", () => {
    const ts = Date.now() - 30 * 60000;
    const u = computeUsage([asst(ts)], 44000);
    const span = u.sessionEnd.getTime() - u.sessionStart.getTime();
    expect(span).toBe(5 * 3600000);
  });
});

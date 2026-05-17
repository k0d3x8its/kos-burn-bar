const { buildSessionBlocks } = require("../../main.js")._test;

const SESSION_GAP_MS  = 60 * 60 * 1000; // 1h — must match main.js
const WINDOW_HOURS_MS = 5 * 60 * 60 * 1000;

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

describe("buildSessionBlocks", () => {
  test("returns empty array for empty input", () => {
    expect(buildSessionBlocks([])).toEqual([]);
  });

  test("returns empty for user-only records (no assistant)", () => {
    const now = Date.now();
    expect(buildSessionBlocks([user(now - 60000)])).toEqual([]);
  });

  test("creates single block for records within 1h of each other", () => {
    const base = Date.now() - 30 * 60000;
    const blocks = buildSessionBlocks([
      asst(base),
      asst(base + 30 * 60000),
    ]);
    expect(blocks).toHaveLength(1);
  });

  test("creates new block after gap >= 1h", () => {
    const base = Date.now() - 3 * 3600000;
    const blocks = buildSessionBlocks([
      asst(base),
      asst(base + SESSION_GAP_MS + 1000), // 1h + 1s gap
    ]);
    expect(blocks).toHaveLength(2);
  });

  test("same block for gap just under 1h (59m 59s)", () => {
    const base = Date.now() - 3 * 3600000;
    const blocks = buildSessionBlocks([
      asst(base),
      asst(base + SESSION_GAP_MS - 1000), // 59m 59s
    ]);
    expect(blocks).toHaveLength(1);
  });

  test("block endTime = startTime + 5h", () => {
    const base = new Date("2024-01-01T10:00:00Z").getTime();
    const blocks = buildSessionBlocks([asst(base)]);
    const span = blocks[0].endTime.getTime() - blocks[0].startTime.getTime();
    expect(span).toBe(WINDOW_HOURS_MS);
  });

  test("new block when record timestamp >= current block endTime", () => {
    const base = new Date("2024-01-01T10:00:00Z").getTime();
    const blocks = buildSessionBlocks([
      asst(base),
      asst(base + WINDOW_HOURS_MS + 1), // beyond 5h window
    ]);
    expect(blocks).toHaveLength(2);
  });

  test("accumulates totalInput and totalOutput correctly", () => {
    const base = Date.now() - 30 * 60000;
    const blocks = buildSessionBlocks([
      asst(base,              { inputTokens: 100, outputTokens: 50 }),
      asst(base + 5 * 60000, { inputTokens: 200, outputTokens: 100 }),
    ]);
    expect(blocks[0].totalInput).toBe(300);
    expect(blocks[0].totalOutput).toBe(150);
  });

  test("accumulates totalCacheCreate and totalCacheRead", () => {
    const base = Date.now() - 30 * 60000;
    const blocks = buildSessionBlocks([
      asst(base, { cacheCreate: 500, cacheRead: 1000 }),
    ]);
    expect(blocks[0].totalCacheCreate).toBe(500);
    expect(blocks[0].totalCacheRead).toBe(1000);
  });

  test("totalCost is non-zero for token-bearing records", () => {
    const base = Date.now() - 30 * 60000;
    const blocks = buildSessionBlocks([asst(base, { outputTokens: 1000 })]);
    expect(blocks[0].totalCost).toBeGreaterThan(0);
  });

  test("counts user messages that fall within block time window", () => {
    const base = Date.now() - 30 * 60000;
    const blocks = buildSessionBlocks([
      asst(base),
      user(base + 60000),     // 1m after block start — inside
      user(base + 5 * 60000), // 5m after start — inside
      user(base + WINDOW_HOURS_MS + 1000), // beyond endTime — outside
    ]);
    expect(blocks[0].messages).toBe(2);
  });

  test("tracks modelTokens per model", () => {
    const base = Date.now() - 30 * 60000;
    const blocks = buildSessionBlocks([
      asst(base,              { model: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 50 }),
      asst(base + 5 * 60000, { model: "claude-haiku-4-5",  inputTokens: 50,  outputTokens: 25 }),
    ]);
    expect(blocks[0].modelTokens["claude-sonnet-4-6"]).toBe(150);
    expect(blocks[0].modelTokens["claude-haiku-4-5"]).toBe(75);
  });

  test("block startTime matches first record timestamp", () => {
    const base = new Date("2024-03-15T08:00:00Z").getTime();
    const blocks = buildSessionBlocks([asst(base)]);
    expect(blocks[0].startTime.getTime()).toBe(base);
  });
});

const { detectTokenLimit } = require("../../main.js")._test;

// Creates a single assistant record with a timestamp far enough in the past
// that its session block (start + 5h) has already ended — i.e. a "completed" block.
// hoursAgo must be > 5 to ensure block is completed.
function completedRec(total, hoursAgo, uuid) {
  return {
    uuid,
    timestamp:         new Date(Date.now() - hoursAgo * 3600000),
    inputTokens:       total / 2,
    outputTokens:      total / 2,
    cacheCreateTokens: 0,
    cacheReadTokens:   0,
    isUserMessage:     false,
    model:             "claude-sonnet-4-6",
  };
}

describe("detectTokenLimit", () => {
  test("returns fallback when no records", () => {
    expect(detectTokenLimit([], 44000)).toBe(44000);
  });

  test("returns fallback when active block only (endTime in future)", () => {
    // Record 10 min ago → block endTime = 10m ago + 5h = far future → active, not completed
    const records = [completedRec(100000, 0.167 /* ~10min */, "active-1")];
    expect(detectTokenLimit(records, 44000)).toBe(44000);
  });

  test("returns fallback when all records older than 8 days", () => {
    const records = [completedRec(100000, 10 * 24 /* 10 days */, "old-1")];
    expect(detectTokenLimit(records, 44000)).toBe(44000);
  });

  test("single completed block returns its total", () => {
    // 7 days ago → completed, within 8-day history
    const records = [completedRec(100000, 7 * 24, "s-1")];
    expect(detectTokenLimit(records, 44000)).toBe(100000);
  });

  test("p90 of multiple completed blocks", () => {
    // 10 records spaced 12h apart starting 7 days ago
    // Each record is its own block (12h gap > 1h SESSION_GAP)
    const now = Date.now();
    const totals = [50000, 60000, 70000, 80000, 90000, 100000, 110000, 120000, 130000, 140000];
    const records = totals.map((total, i) => ({
      uuid:              `p90-${i}`,
      timestamp:         new Date(now - (7 * 24 * 3600000 - i * 12 * 3600000)),
      inputTokens:       total / 2,
      outputTokens:      total / 2,
      cacheCreateTokens: 0,
      cacheReadTokens:   0,
      isUserMessage:     false,
      model:             "claude-sonnet-4-6",
    }));
    // sorted ascending → [50K..140K], p90idx = floor(10*0.9) = 9 → 140000
    expect(detectTokenLimit(records, 44000)).toBe(140000);
  });

  test("deduplicates records before building blocks", () => {
    // Two records with same UUID — should produce 1 block, not 2
    const base = completedRec(100000, 7 * 24, "dup-uuid");
    const records = [base, { ...base }];
    // With dedup: 1 block, total = 100000
    expect(detectTokenLimit(records, 44000)).toBe(100000);
  });

  test("active block excluded even when it has the highest total", () => {
    const now = Date.now();
    const records = [
      // Completed block 7 days ago, total = 50000
      completedRec(50000, 7 * 24, "old-c"),
      // Active block right now, total = 999999 — must NOT influence limit
      {
        uuid:              "active-huge",
        timestamp:         new Date(now - 10 * 60000),
        inputTokens:       500000,
        outputTokens:      499999,
        cacheCreateTokens: 0,
        cacheReadTokens:   0,
        isUserMessage:     false,
        model:             "claude-sonnet-4-6",
      },
    ];
    // p90 of completed blocks only: [50000] → 50000
    expect(detectTokenLimit(records, 44000)).toBe(50000);
  });
});

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { parseFile } = require("../../main.js")._test;

function writeTmp(lines) {
  const f = path.join(os.tmpdir(), "kos-parse-" + Date.now() + Math.random() + ".jsonl");
  fs.writeFileSync(f, lines.join("\n"));
  return f;
}

afterEach(() => {
  // tmp files are cleaned by OS; no explicit cleanup needed
});

describe("parseFile", () => {
  test("parses assistant record with all four token types", () => {
    const f = writeTmp([JSON.stringify({
      timestamp: "2024-01-01T12:00:00Z",
      type: "assistant",
      uuid: "a1",
      message: {
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 500,
        },
      },
    })]);
    const records = [];
    parseFile(f, records);
    expect(records).toHaveLength(1);
    expect(records[0].inputTokens).toBe(10);
    expect(records[0].outputTokens).toBe(20);
    expect(records[0].cacheCreateTokens).toBe(100);
    expect(records[0].cacheReadTokens).toBe(500);
    expect(records[0].isUserMessage).toBe(false);
    expect(records[0].model).toBe("claude-sonnet-4-6");
    expect(records[0].uuid).toBe("a1");
    fs.unlinkSync(f);
  });

  test("parses user record with zero tokens", () => {
    const f = writeTmp([JSON.stringify({
      timestamp: "2024-01-01T12:00:00Z",
      type: "user",
      uuid: "u1",
    })]);
    const records = [];
    parseFile(f, records);
    expect(records).toHaveLength(1);
    expect(records[0].isUserMessage).toBe(true);
    expect(records[0].inputTokens).toBe(0);
    expect(records[0].outputTokens).toBe(0);
    expect(records[0].model).toBeNull();
    fs.unlinkSync(f);
  });

  test("skips synthetic model records", () => {
    const f = writeTmp([JSON.stringify({
      timestamp: "2024-01-01T12:00:00Z",
      type: "assistant",
      uuid: "s1",
      message: { model: "<synthetic>", usage: { input_tokens: 10, output_tokens: 20 } },
    })]);
    const records = [];
    parseFile(f, records);
    expect(records).toHaveLength(0);
    fs.unlinkSync(f);
  });

  test("skips all-zero assistant records", () => {
    const f = writeTmp([JSON.stringify({
      timestamp: "2024-01-01T12:00:00Z",
      type: "assistant",
      uuid: "z1",
      message: {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })]);
    const records = [];
    parseFile(f, records);
    expect(records).toHaveLength(0);
    fs.unlinkSync(f);
  });

  test("skips records without timestamp", () => {
    const f = writeTmp([JSON.stringify({
      type: "assistant",
      uuid: "t1",
      message: { model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 5 } },
    })]);
    const records = [];
    parseFile(f, records);
    expect(records).toHaveLength(0);
    fs.unlinkSync(f);
  });

  test("skips malformed JSON lines but continues parsing", () => {
    const f = writeTmp([
      "{this is not json}",
      JSON.stringify({ timestamp: "2024-01-01T12:00:00Z", type: "user", uuid: "ok1" }),
    ]);
    const records = [];
    parseFile(f, records);
    expect(records).toHaveLength(1);
    fs.unlinkSync(f);
  });

  test("skips blank lines silently", () => {
    const f = writeTmp([
      "",
      "   ",
      JSON.stringify({ timestamp: "2024-01-01T12:00:00Z", type: "user", uuid: "ok2" }),
    ]);
    const records = [];
    parseFile(f, records);
    expect(records).toHaveLength(1);
    fs.unlinkSync(f);
  });

  test("handles nonexistent file gracefully", () => {
    const records = [];
    parseFile("/nonexistent/path/session.jsonl", records);
    expect(records).toHaveLength(0);
  });

  test("skips assistant records missing usage field", () => {
    const f = writeTmp([JSON.stringify({
      timestamp: "2024-01-01T12:00:00Z",
      type: "assistant",
      uuid: "nu1",
      message: { model: "claude-sonnet-4-6" },
    })]);
    const records = [];
    parseFile(f, records);
    expect(records).toHaveLength(0);
    fs.unlinkSync(f);
  });

  test("timestamp stored as Date object", () => {
    const f = writeTmp([JSON.stringify({
      timestamp: "2024-06-15T10:30:00Z",
      type: "user",
      uuid: "d1",
    })]);
    const records = [];
    parseFile(f, records);
    expect(records[0].timestamp).toBeInstanceOf(Date);
    expect(records[0].timestamp.getFullYear()).toBe(2024);
    fs.unlinkSync(f);
  });
});

const { deduplicateRecords } = require("../../main.js")._test;

function rec(uuid, inputTokens = 10) {
  return { uuid, inputTokens };
}

describe("deduplicateRecords", () => {
  test("removes exact UUID duplicates", () => {
    const input = [rec("a"), rec("a"), rec("b")];
    expect(deduplicateRecords(input)).toHaveLength(2);
  });

  test("keeps first occurrence of a duplicate", () => {
    const input = [rec("a", 10), rec("a", 99)];
    expect(deduplicateRecords(input)[0].inputTokens).toBe(10);
  });

  test("keeps all records without UUID (null UUID not deduped)", () => {
    const input = [rec(null, 10), rec(null, 20), rec(null, 30)];
    expect(deduplicateRecords(input)).toHaveLength(3);
  });

  test("returns empty array for empty input", () => {
    expect(deduplicateRecords([])).toEqual([]);
  });

  test("preserves records with unique UUIDs unchanged", () => {
    const input = [rec("a"), rec("b"), rec("c")];
    expect(deduplicateRecords(input)).toHaveLength(3);
  });

  test("handles mixed null and non-null UUIDs", () => {
    const input = [rec("a"), rec(null), rec("a"), rec(null)];
    // "a" deduped to 1, both nulls kept → 3 total
    expect(deduplicateRecords(input)).toHaveLength(3);
  });
});

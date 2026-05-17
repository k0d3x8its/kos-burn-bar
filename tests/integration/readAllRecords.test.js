const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { readAllRecords } = require("../../main.js")._test;

function assistantLine(uuid, overrides = {}) {
  return JSON.stringify({
    timestamp: "2024-06-01T12:00:00Z",
    type: "assistant",
    uuid,
    message: {
      model: "claude-sonnet-4-6",
      usage: {
        input_tokens:                overrides.input  ?? 10,
        output_tokens:               overrides.output ?? 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens:     0,
      },
    },
  });
}

describe("readAllRecords (integration)", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kos-projects-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeProject(projectName, filename, lines) {
    const projDir = path.join(tmpDir, projectName);
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, filename), lines.join("\n"));
  }

  test("returns empty array when claudeDir does not exist", () => {
    const records = readAllRecords("", "/nonexistent/kos-test-dir");
    expect(records).toEqual([]);
  });

  test("reads records from all projects when no filter", () => {
    writeProject("project-alpha", "session.jsonl", [assistantLine("r1")]);
    writeProject("project-beta",  "session.jsonl", [assistantLine("r2")]);
    const records = readAllRecords("", tmpDir);
    expect(records).toHaveLength(2);
  });

  test("filters projects by substring", () => {
    writeProject("my-webapp",      "session.jsonl", [assistantLine("r1")]);
    writeProject("other-project",  "session.jsonl", [assistantLine("r2")]);
    const records = readAllRecords("my-webapp", tmpDir);
    expect(records).toHaveLength(1);
  });

  test("empty filter matches all projects", () => {
    writeProject("proj-a", "session.jsonl", [assistantLine("r1")]);
    writeProject("proj-b", "session.jsonl", [assistantLine("r2")]);
    writeProject("proj-c", "session.jsonl", [assistantLine("r3")]);
    const records = readAllRecords("", tmpDir);
    expect(records).toHaveLength(3);
  });

  test("filter with no match returns empty array", () => {
    writeProject("project-x", "session.jsonl", [assistantLine("r1")]);
    const records = readAllRecords("does-not-match", tmpDir);
    expect(records).toHaveLength(0);
  });

  test("reads nested jsonl files inside project subdirectories", () => {
    const projDir = path.join(tmpDir, "my-project");
    const subDir  = path.join(projDir, "nested");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, "deep.jsonl"), assistantLine("nested-r1"));
    const records = readAllRecords("", tmpDir);
    expect(records).toHaveLength(1);
  });

  test("ignores non-jsonl files", () => {
    const projDir = path.join(tmpDir, "my-project");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "notes.txt"),    "not a jsonl");
    fs.writeFileSync(path.join(projDir, "session.jsonl"), assistantLine("r1"));
    const records = readAllRecords("", tmpDir);
    expect(records).toHaveLength(1);
  });

  test("ignores top-level files (not inside a project dir)", () => {
    // File directly in tmpDir, not inside a project subdirectory
    fs.writeFileSync(path.join(tmpDir, "stray.jsonl"), assistantLine("stray-r1"));
    const records = readAllRecords("", tmpDir);
    expect(records).toHaveLength(0);
  });

  test("multiple jsonl files in same project are all read", () => {
    writeProject("my-project", "session1.jsonl", [assistantLine("r1")]);
    writeProject("my-project", "session2.jsonl", [assistantLine("r2")]);
    const records = readAllRecords("", tmpDir);
    expect(records).toHaveLength(2);
  });

  test("multiple records in one jsonl file are all parsed", () => {
    writeProject("my-project", "session.jsonl", [
      assistantLine("r1"),
      assistantLine("r2"),
      assistantLine("r3"),
    ]);
    const records = readAllRecords("", tmpDir);
    expect(records).toHaveLength(3);
  });

  test("token values are preserved through file read", () => {
    writeProject("my-project", "session.jsonl", [assistantLine("tok-r1", { input: 42, output: 99 })]);
    const records = readAllRecords("", tmpDir);
    expect(records[0].inputTokens).toBe(42);
    expect(records[0].outputTokens).toBe(99);
  });
});

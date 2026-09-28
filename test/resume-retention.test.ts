import { existsSync, readFileSync, symlinkSync, utimesSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveResume } from "../src/core/resume.ts";
import { createRunRecord } from "../src/core/run-record.ts";
import { pruneRunRecords } from "../src/core/retention.ts";

const roots: string[] = [];
function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "pi-flow-retention-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function writeRecord(runsDir: string, runId: string, summary: unknown, complete = true): void {
  const directory = join(runsDir, runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "events.ndjson"), ["run_started", "run_finished"].map((type, sequence) =>
    JSON.stringify({ version: 1, runId, sequence, type })).join("\n") + "\n");
  if (complete) {
    writeFileSync(join(directory, "summary.json"), JSON.stringify({ version: 1, runId, finishedAt: new Date().toISOString(), eventCount: 2, summary: { status: "done", ...(summary as object) } }));
  }
}
describe("resume resolution", () => {
  it("resolves a recorded session id for the same backend", async () => {
    const root = tempRoot();
    const runsDir = join(root, "runs");
    writeRecord(runsDir, "run_abc", { backend: "claude", sessionId: "sess-1" });
    const resolved = await resolveResume(runsDir, "run_abc", "claude");
    expect(resolved.session).toEqual({ runId: "run_abc", sessionId: "sess-1", backend: "claude" });
  });

  it("rejects a backend mismatch instead of cross-harness resume", async () => {
    const root = tempRoot();
    const runsDir = join(root, "runs");
    writeRecord(runsDir, "run_abc", { backend: "codex", sessionId: "thread-1" });
    const resolved = await resolveResume(runsDir, "run_abc", "claude");
    expect(resolved.error).toMatch(/same backend/);
  });

  it("resolves a recorded grok session id and rejects resuming it from another backend", async () => {
    const root = tempRoot();
    const runsDir = join(root, "runs");
    writeRecord(runsDir, "run_grok", { backend: "grok", sessionId: "grok-sess-1" });
    const resolved = await resolveResume(runsDir, "run_grok", "grok");
    expect(resolved.session).toEqual({ runId: "run_grok", sessionId: "grok-sess-1", backend: "grok" });

    const mismatched = await resolveResume(runsDir, "run_grok", "claude");
    expect(mismatched.error).toMatch(/same backend/);
  });

  it("resolves a recorded muse session id (verified against a real muse exec --session-id recall) and rejects resuming it from another backend", async () => {
    const root = tempRoot();
    const runsDir = join(root, "runs");
    writeRecord(runsDir, "run_muse", { backend: "muse", sessionId: "muse-sess-1" });
    const resolved = await resolveResume(runsDir, "run_muse", "muse");
    expect(resolved.session).toEqual({ runId: "run_muse", sessionId: "muse-sess-1", backend: "muse" });

    const mismatched = await resolveResume(runsDir, "run_muse", "claude");
    expect(mismatched.error).toMatch(/same backend/);
  });

  it("rejects unknown or incomplete records and malformed ids", async () => {
    const root = tempRoot();
    const runsDir = join(root, "runs");
    writeRecord(runsDir, "run_incomplete", { backend: "claude" }, false);
    expect((await resolveResume(runsDir, "run_missing", "claude")).error).toMatch(/No completed run record/);
    expect((await resolveResume(runsDir, "run_incomplete", "claude")).error).toMatch(/No completed run record/);
    expect((await resolveResume(runsDir, "../escape", "claude")).error).toMatch(/Invalid resume run id/);
  });
});

describe("run record retention", () => {
  it("prunes oldest completed records beyond the cap and keeps incomplete ones", async () => {
    const root = tempRoot();
    const runsDir = join(root, "runs");
    const records = [];
    // Use the production writer so eligibility follows its real contract.
    for (let index = 0; index < 4; index++) {
      const record = createRunRecord({ directory: runsDir });
      await record.finish({ status: "done", backend: "claude", sessionId: `s${index}` });
      const time = new Date(Date.now() - (10 - index) * 60_000);
      utimesSync(record.directory, time, time);
      records.push(record);
    }
    const active = createRunRecord({ directory: runsDir });
    await active.event("execution_started");

    const { pruned, kept } = await pruneRunRecords(runsDir, 3);
    expect(pruned).toEqual([records[0]!.directory]);
    expect(kept).toBe(3);
    expect(existsSync(active.directory)).toBe(true);
  });

  it.each([
    "malformed-summary", "wrong-run", "null-summary", "array-summary", "missing-summary",
    "future-version", "running", "queued", "missing-finish-time", "write-errors",
    "missing-events", "malformed-events", "truncated-events", "foreign-events",
    "empty-events", "missing-terminal-event", "missing-start-event", "event-count", "sequence-gap", "attempted-events",
  ])("preserves %s evidence while pruning eligible records", async (damage) => {
    const runsDir = tempRoot();
    for (const runId of ["run_damaged", "run_old", "run_new"]) {
      writeRecord(runsDir, runId, { backend: "claude" });
      const time = runId === "run_new" ? 3000 : runId === "run_old" ? 2000 : 1000;
      utimesSync(join(runsDir, runId), time, time);
    }
    const directory = join(runsDir, "run_damaged");
    const summaryPath = join(directory, "summary.json");
    const eventsPath = join(directory, "events.ndjson");
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    const events = readFileSync(eventsPath, "utf8");
    switch (damage) {
      case "wrong-run": summary.runId = "run_other"; break;
      case "null-summary": summary.summary = null; break;
      case "array-summary": summary.summary = []; break;
      case "missing-summary": delete summary.summary; break;
      case "future-version": summary.version = 99; break;
      case "running": case "queued": summary.summary.status = damage; break;
      case "missing-finish-time": delete summary.finishedAt; break;
      case "write-errors": summary.writeErrorCount = 1; break;
      case "event-count": summary.eventCount = 3; break;
      case "attempted-events": summary.attemptedEventCount = 3; break;
      case "missing-events": rmSync(eventsPath); break;
      case "malformed-events": writeFileSync(eventsPath, events + "{bad}\n"); break;
      case "truncated-events": writeFileSync(eventsPath, events + "{tail"); break;
      case "foreign-events": writeFileSync(eventsPath, events.replaceAll("run_damaged", "run_foreign")); break;
      case "empty-events": writeFileSync(eventsPath, ""); break;
      case "missing-terminal-event": writeFileSync(eventsPath, events.split("\n")[0] + "\n"); break;
      case "missing-start-event": writeFileSync(eventsPath, events.replace("run_started", "activity")); break;
      case "sequence-gap": writeFileSync(eventsPath, events.replace('"sequence":1', '"sequence":9')); break;
    }
    writeFileSync(summaryPath, damage === "malformed-summary" ? "{bad" : JSON.stringify(summary));
    const { pruned, kept } = await pruneRunRecords(runsDir, 1);
    expect(pruned).toEqual([join(runsDir, "run_old")]);
    expect(kept).toBe(1);
    expect(existsSync(directory)).toBe(true);
  });

  it("prunes complete failures and cancellations but does not follow linked run directories", async () => {
    const runsDir = tempRoot();
    const outside = tempRoot();
    writeRecord(outside, "run_link", { status: "done" });
    symlinkSync(join(outside, "run_link"), join(runsDir, "run_link"));
    for (const [index, status] of ["error", "aborted", "done"].entries()) {
      writeRecord(runsDir, `run_${index}`, { status });
      utimesSync(join(runsDir, `run_${index}`), index + 1, index + 1);
    }
    expect((await pruneRunRecords(runsDir, 1)).pruned).toEqual([join(runsDir, "run_0"), join(runsDir, "run_1")]);
    expect(existsSync(join(runsDir, "run_link"))).toBe(true);
    expect(existsSync(join(outside, "run_link", "summary.json"))).toBe(true);
  });

  it("keeps everything when disabled", async () => {
    const root = tempRoot();
    const runsDir = join(root, "runs");
    writeRecord(runsDir, "run_a", { backend: "claude", sessionId: "s" });
    const { pruned } = await pruneRunRecords(runsDir, 0);
    expect(pruned).toEqual([]);
  });
});

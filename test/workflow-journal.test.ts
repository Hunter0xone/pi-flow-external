import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkflowJournalWriter, createWorkflowRunIdentity, loadWorkflowJournal, persistWorkflowScript } from "../src/workflow/journal.ts";

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-workflow-permissions-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("private workflow evidence", () => {
  it.each([false, true])("keeps scripts, journals and directories private (legacy: %s)", async (legacy) => {
    const dir = join(await temporaryRoot(), "session.workflows");
    const script = "return 'private result';";
    const identity = createWorkflowRunIdentity(script, null);
    const scriptPath = join(dir, `private-${identity.scriptHash.slice(0, 12)}.js`);
    const journalPath = join(dir, `run-${identity.runId}.jsonl`);
    if (legacy) {
      await mkdir(dir);
      await chmod(dir, 0o777);
      for (const path of [scriptPath, journalPath]) {
        await writeFile(path, "legacy");
        await chmod(path, 0o666);
      }
    }
    expect(await persistWorkflowScript({ dir, metaName: "private", scriptHash: identity.scriptHash, script })).toBe(scriptPath);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(scriptPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(scriptPath, "utf8")).toBe(script);

    const writer = await createWorkflowJournalWriter({ dir, identity, name: "private", source: "inline" });
    expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
    await chmod(journalPath, 0o666);
    await writer.complete("private result");
    expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
    expect(await loadWorkflowJournal(dir, identity.runId)).toMatchObject({ status: "done", result: "private result" });

    // If a journal is removed externally, append must still create it privately.
    await rm(journalPath);
    await writer.fail("removed externally");
    expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
  });

  it("refuses linked scripts and journals without overwriting their targets", async () => {
    const dir = await temporaryRoot();
    const target = join(await temporaryRoot(), "unrelated.txt");
    await writeFile(target, "keep me");
    const identity = createWorkflowRunIdentity("return 1;", null);
    await symlink(target, join(dir, `private-${identity.scriptHash.slice(0, 12)}.js`));
    await symlink(target, join(dir, `run-${identity.runId}.jsonl`));
    await expect(persistWorkflowScript({ dir, metaName: "private", scriptHash: identity.scriptHash, script: "return 1;" })).rejects.toThrow();
    await expect(createWorkflowJournalWriter({ dir, identity, name: "private", source: "inline" })).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("keep me");
  });
});

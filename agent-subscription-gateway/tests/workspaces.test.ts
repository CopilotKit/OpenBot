import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scrubProviderEnvironment,
  WorkspaceManager,
} from "../src/workspaces/workspace-manager";
import { cleanupExpiredWorkspaces } from "../src/workspaces/cleanup";
import { RunStore } from "../src/storage/run-store";

const directories: string[] = [];

function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync(
    ["git", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openbot-workspace-"));
  directories.push(root);
  const source = join(root, "source");
  const jobs = join(root, "jobs");
  await mkdir(source);
  git(source, ["init", "--initial-branch=main"]);
  git(source, ["config", "user.name", "Test User"]);
  git(source, ["config", "user.email", "test@example.com"]);
  await writeFile(join(source, "README.md"), "before\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-m", "initial"]);
  return { source, jobs };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("isolated workspaces", () => {
  test("clones only the fixed repository and branch into a validated run path", async () => {
    const { source, jobs } = await fixture();
    const manager = new WorkspaceManager({
      provider: "codex",
      repository: source,
      baseBranch: "main",
      jobRoot: jobs,
    });

    const workspace = await manager.create("run-1");
    expect(workspace.path).toBe(join(jobs, "codex", "run-1"));
    expect(await readFile(join(workspace.path, "README.md"), "utf8")).toBe(
      "before\n",
    );
    expect(git(workspace.path, ["branch", "--show-current"])).toBe("");
    expect(() => manager.pathFor("../escape")).toThrow(/run ID/i);
  }, 15_000);

  test("retains a binary patch and commit metadata without provider push credentials", async () => {
    const { source, jobs } = await fixture();
    const manager = new WorkspaceManager({
      provider: "claude",
      repository: source,
      baseBranch: "main",
      jobRoot: jobs,
    });
    const workspace = await manager.create("run-2");
    await writeFile(join(workspace.path, "README.md"), "after\n");
    await writeFile(join(workspace.path, "new-file.txt"), "new\n");

    const result = await manager.captureResult(workspace);
    expect(result.patch).toContain("-before");
    expect(result.patch).toContain("+after");
    expect(result.patch).toContain("new-file.txt");
    expect(result.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.commits).toEqual([]);

    const environment = scrubProviderEnvironment({
      PATH: process.env.PATH,
      GITHUB_TOKEN: "push-secret",
      GH_TOKEN: "another-secret",
      GIT_ASKPASS: "/credential-helper",
      AWS_SESSION_TOKEN: "instance-secret",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      SAFE_VALUE: "kept",
    });
    expect(environment).toEqual(
      expect.objectContaining({ SAFE_VALUE: "kept" }),
    );
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(environment).not.toHaveProperty("GH_TOKEN");
    expect(environment).not.toHaveProperty("GIT_ASKPASS");
    expect(environment).not.toHaveProperty("AWS_SESSION_TOKEN");
    expect(environment).not.toHaveProperty("DOCKER_HOST");
    expect(git(workspace.path, ["remote", "get-url", "--push", "origin"])).toBe(
      "disabled://push-not-allowed",
    );
  }, 15_000);

  test("cleanup cannot cross the configured job root", async () => {
    const { source, jobs } = await fixture();
    const manager = new WorkspaceManager({
      provider: "grok",
      repository: source,
      baseBranch: "main",
      jobRoot: jobs,
    });
    const first = await manager.create("run-a");
    const second = await manager.create("run-b");

    await manager.remove(first.path);
    expect(await Bun.file(join(first.path, "README.md")).exists()).toBe(false);
    expect(await Bun.file(join(second.path, "README.md")).exists()).toBe(true);
    await expect(manager.remove(source)).rejects.toThrow(/job root/i);
  }, 15_000);

  test("cleans only expired terminal workspaces and keeps the retained result", async () => {
    const { source, jobs } = await fixture();
    const manager = new WorkspaceManager({
      provider: "codex",
      repository: source,
      baseBranch: "main",
      jobRoot: jobs,
    });
    const completed = await manager.create("completed");
    const active = await manager.create("active");
    const runs = new RunStore(join(jobs, "state.sqlite"));
    for (const runId of ["completed", "active"]) {
      runs.reserveRun({
        provider: "codex",
        runId,
        threadId: `thread-${runId}`,
      });
      runs.transitionRun("codex", runId, "preparing", ["queued"]);
      runs.attachWorkspace(
        "codex",
        runId,
        runId === "completed" ? completed.path : active.path,
      );
      runs.transitionRun("codex", runId, "running", ["preparing"]);
    }
    runs.saveResult("codex", "completed", {
      patch: "retained-patch",
      baseCommit: completed.baseCommit,
      commits: [],
    });
    runs.transitionRun("codex", "completed", "completed", ["running"]);

    expect(
      await cleanupExpiredWorkspaces(runs, manager, Date.now() + 1_000),
    ).toEqual([completed.path]);
    expect(await Bun.file(join(completed.path, "README.md")).exists()).toBe(
      false,
    );
    expect(await Bun.file(join(active.path, "README.md")).exists()).toBe(true);
    expect(runs.getRun("codex", "completed")).toMatchObject({
      state: "completed",
      patch: "retained-patch",
    });
    expect(runs.getRun("codex", "completed")).not.toHaveProperty(
      "workspacePath",
    );
    runs.close();
  }, 15_000);
});

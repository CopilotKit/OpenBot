import { mkdir, realpath, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { CommitMetadata } from "../storage/run-store";

const SAFE_SEGMENT = /^[A-Za-z0-9._:-]{1,200}$/;
const execFileAsync = promisify(execFile);
const PUSH_ENVIRONMENT = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
]);

export interface WorkspaceLease {
  provider: string;
  runId: string;
  path: string;
  baseCommit: string;
}

export interface WorkspaceResult {
  patch: string;
  baseCommit: string;
  commits: CommitMetadata[];
}

export function scrubProviderEnvironment(
  environment: Record<string, string | undefined>,
): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (PUSH_ENVIRONMENT.has(name) || name.startsWith("GIT_CONFIG_")) continue;
    scrubbed[name] = value;
  }
  scrubbed.GIT_TERMINAL_PROMPT = "0";
  return scrubbed;
}

function assertSafeSegment(label: string, value: string): void {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid ${label}.`);
  }
}

async function command(
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<string> {
  const [program, ...rawProgramArgs] = args;
  if (!program) throw new Error("Workspace command is empty.");
  const programArgs =
    program === "git"
      ? ["-c", "core.hooksPath=/dev/null", ...rawProgramArgs]
      : rawProgramArgs;
  try {
    const { stdout } = await execFileAsync(program, programArgs, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    throw new Error("Git workspace operation failed.");
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(path)
  );
}

export class WorkspaceManager {
  private readonly provider: string;
  private readonly repository: string;
  private readonly baseBranch: string;
  private readonly jobRoot: string;
  private readonly gitEnvironment: Record<string, string>;

  constructor(options: {
    provider: string;
    repository: string;
    baseBranch: string;
    jobRoot: string;
    gitEnvironment?: Record<string, string | undefined>;
  }) {
    assertSafeSegment("provider", options.provider);
    assertSafeSegment("base branch", options.baseBranch);
    if (!options.repository.trim()) throw new Error("Repository is required.");
    if (/^https?:\/\//i.test(options.repository)) {
      const repositoryUrl = new URL(options.repository);
      if (repositoryUrl.username || repositoryUrl.password) {
        throw new Error("Repository URL must not contain credentials.");
      }
    }
    if (!isAbsolute(options.jobRoot))
      throw new Error("Job root must be absolute.");
    this.provider = options.provider;
    this.repository = options.repository;
    this.baseBranch = options.baseBranch;
    this.jobRoot = resolve(options.jobRoot);
    this.gitEnvironment = scrubProviderEnvironment({
      ...process.env,
      ...options.gitEnvironment,
    });
  }

  pathFor(runId: string): string {
    assertSafeSegment("run ID", runId);
    const candidate = resolve(this.jobRoot, this.provider, runId);
    if (!inside(this.jobRoot, candidate))
      throw new Error("Workspace escaped the job root.");
    return candidate;
  }

  async create(runId: string): Promise<WorkspaceLease> {
    const target = this.pathFor(runId);
    await mkdir(join(this.jobRoot, this.provider), {
      recursive: true,
      mode: 0o700,
    });
    const cloneIsolation = isAbsolute(this.repository)
      ? ["--no-hardlinks"]
      : ["--no-local"];
    try {
      await command(
        [
          "git",
          "clone",
          ...cloneIsolation,
          "--single-branch",
          "--branch",
          this.baseBranch,
          "--no-checkout",
          "--",
          this.repository,
          target,
        ],
        { env: this.gitEnvironment },
      );
      await command(["git", "checkout", "--detach", this.baseBranch], {
        cwd: target,
        env: this.gitEnvironment,
      });
      await command(
        [
          "git",
          "remote",
          "set-url",
          "--push",
          "origin",
          "disabled://push-not-allowed",
        ],
        { cwd: target, env: this.gitEnvironment },
      );
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
    const canonicalRoot = await realpath(this.jobRoot);
    const canonicalTarget = await realpath(target);
    if (!inside(canonicalRoot, canonicalTarget)) {
      await rm(target, { recursive: true, force: true });
      throw new Error("Workspace escaped the canonical job root.");
    }
    const baseCommit = (
      await command(["git", "rev-parse", "HEAD"], { cwd: target })
    ).trim();
    return { provider: this.provider, runId, path: target, baseCommit };
  }

  async captureResult(workspace: WorkspaceLease): Promise<WorkspaceResult> {
    await this.assertOwned(workspace.path);
    const untracked = await command(
      ["git", "ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: workspace.path },
    );
    const untrackedPaths = untracked.split("\0").filter(Boolean);
    if (untrackedPaths.length > 0) {
      await command(
        ["git", "add", "--intent-to-add", "--", ...untrackedPaths],
        {
          cwd: workspace.path,
        },
      );
    }
    const patch = await command(
      ["git", "diff", "--binary", "--no-ext-diff", workspace.baseCommit, "--"],
      { cwd: workspace.path },
    );
    const log = await command(
      [
        "git",
        "log",
        "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e",
        `${workspace.baseCommit}..HEAD`,
        "--",
      ],
      { cwd: workspace.path },
    );
    const commits = log
      .split("\u001e")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry): CommitMetadata => {
        const [hash, parents, authorName, authorEmail, authoredAt, subject] =
          entry.split("\u001f");
        return {
          hash: hash ?? "",
          subject: subject ?? "",
          parents: parents ? parents.split(" ").filter(Boolean) : [],
          authorName,
          authorEmail,
          authoredAt,
        };
      });
    return { patch, baseCommit: workspace.baseCommit, commits };
  }

  async remove(path: string): Promise<void> {
    await this.assertOwned(path);
    await rm(path, { recursive: true, force: true });
  }

  private async assertOwned(path: string): Promise<void> {
    const candidate = resolve(path);
    if (!inside(this.jobRoot, candidate)) {
      throw new Error("Workspace is outside the configured job root.");
    }
    const canonicalRoot = await realpath(this.jobRoot);
    const canonicalCandidate = await realpath(candidate);
    if (!inside(canonicalRoot, canonicalCandidate)) {
      throw new Error("Workspace is outside the canonical job root.");
    }
  }
}

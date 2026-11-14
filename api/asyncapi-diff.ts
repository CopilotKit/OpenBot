/**
 * The breaking-change check for api/asyncapi.yaml: `bun api/asyncapi-diff.ts <base.yaml> <head.yaml>`.
 *
 * The differences come from the AsyncAPI CLI's `diff` (pinned in api/asyncapi-tools), which wraps
 * the AsyncAPI Initiative's diff library. That library is still 0.x, and what it knows is the
 * AsyncAPI document's own structure: it calls a changed channel address, a removed channel or a
 * removed message breaking, and calls every change inside a message's payload schema
 * "unclassified", because a JSON Schema can be any depth and its rules are written per path.
 *
 * So this file relies on the library for one thing, the list of what changed and where, and decides
 * what a payload change means itself, strictly: a change is let through only when it is known to
 * take nothing from a client (new things, a new optional member, wording). Anything else fails,
 * unless api/accepted-live-breaking-changes.md lists it with its reason.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Change = {
  action: "add" | "remove" | "edit";
  path: string;
  type: "breaking" | "non-breaking" | "unclassified";
};

/** Wording: changing it changes no frame. */
const WORDING = new Set(["description", "summary", "title", "examples"]);

/**
 * Whether a path is a second copy of a change. The diff works on the document with every $ref
 * followed, so one change to a schema is reported where the schema is defined and again under every
 * message, channel and operation that uses it. The definition is judged; the copies are not.
 */
function isCopy(path: string): boolean {
  return (
    /^\/components\/messages\/[^/]+\/payload\/./.test(path) ||
    /^\/channels\/[^/]+\/messages\/[^/]+\/./.test(path) ||
    /^\/operations\/[^/]+\/messages\/[^/]+\/./.test(path) ||
    /^\/operations\/[^/]+\/channel\/./.test(path) ||
    /\/x-parser-[^/]+$/.test(path)
  );
}

/**
 * Whether a change is to wording only, on a schema, message, channel or operation. A payload member
 * that happens to be called "description" is a member, not wording.
 */
function isWording(path: string): boolean {
  const segments = path.split("/").slice(1);
  const last = segments[segments.length - 1] ?? "";
  const parent = segments[segments.length - 2] ?? "";
  return (
    (WORDING.has(last) && parent !== "properties") ||
    segments.includes("examples")
  );
}

/** An addition known to take nothing from a client. */
function isSafeAddition(change: Change): boolean {
  if (change.action !== "add") return false;
  // Something new: a channel, an operation, a message, a server, a component.
  if (/^\/(channels|operations|servers)\/[^/]+$/.test(change.path)) return true;
  if (/^\/channels\/[^/]+\/messages\/[^/]+$/.test(change.path)) return true;
  if (/^\/operations\/[^/]+\/messages\/[^/]+$/.test(change.path)) return true;
  if (/^\/components\/[^/]+\/[^/]+$/.test(change.path)) return true;
  // A new member of a payload. If it is also made required, that is its own change, under
  // `required`, and is not let through here.
  return /^\/components\/schemas\/.+\/properties\/[^/]+$/.test(change.path);
}

/** The lines of the accepted file: each names one change as `action path`. */
export function acceptedChanges(markdown: string): Set<string> {
  const accepted = new Set<string>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const named = /`(add|remove|edit) (\/[^`]+)`/.exec(line);
    if (named) accepted.add(`${named[1]} ${named[2]}`);
  }
  return accepted;
}

/** The changes that fail the check. */
export function failing(
  changes: readonly Change[],
  accepted: ReadonlySet<string> = new Set(),
): Change[] {
  return changes.filter((change) => {
    if (isCopy(change.path)) return false;
    if (accepted.has(`${change.action} ${change.path}`)) return false;
    if (isWording(change.path)) return false;
    if (change.type === "breaking") return true;
    if (change.type === "non-breaking") return false;
    return !isSafeAddition(change);
  });
}

/** Every difference between two files, as the AsyncAPI CLI reports them. */
export function differences(base: string, head: string): Change[] {
  const cli = join(
    import.meta.dir,
    "asyncapi-tools/node_modules/.bin/asyncapi",
  );
  if (!existsSync(cli)) {
    throw new Error(
      "The AsyncAPI CLI is not installed. Run: bun install --cwd api/asyncapi-tools --frozen-lockfile",
    );
  }
  const run = spawnSync(
    cli,
    ["diff", base, head, "--type", "all", "--format", "json", "--no-error"],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, ASYNCAPI_ANALYTICS: "false", CI: "true" },
    },
  );
  const start = run.stdout.indexOf("{");
  if (run.status !== 0 || start < 0) {
    throw new Error(
      `asyncapi diff failed (exit ${run.status}):\n${run.stdout}\n${run.stderr}`,
    );
  }
  const report = JSON.parse(run.stdout.slice(start)) as { changes: Change[] };
  return report.changes;
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("usage: bun api/asyncapi-diff.ts <base.yaml> <head.yaml>");
    process.exit(2);
  }
  const accepted = acceptedChanges(
    readFileSync(
      join(import.meta.dir, "accepted-live-breaking-changes.md"),
      "utf8",
    ),
  );
  const failed = failing(differences(base, head), accepted);
  if (failed.length === 0) {
    console.log("No change to api/asyncapi.yaml breaks a client.");
    process.exit(0);
  }
  for (const change of failed) {
    console.error(`${change.type}: \`${change.action} ${change.path}\``);
    if (process.env.GITHUB_ACTIONS) {
      console.error(
        `::error file=api/asyncapi.yaml::${change.type} change: ${change.action} ${change.path}`,
      );
    }
  }
  console.error(
    `\n${failed.length} change(s) to api/asyncapi.yaml could break a client. If one takes nothing from a client, list it with its reason in api/accepted-live-breaking-changes.md.`,
  );
  process.exit(1);
}

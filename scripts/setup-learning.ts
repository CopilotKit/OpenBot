import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const CONTAINER = "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID";
const MANAGED_API = "https://api.intelligence.copilotkit.ai";
type CliResult = { exitCode: number; stdout: string };
type RunCli = (args: string[], directory: string) => Promise<CliResult>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function json(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (object(value)) return value;
  } catch {}
  throw new Error(
    "CopilotKit returned an invalid setup response. No Learning assignment was saved.",
  );
}

async function runCli(args: string[], directory: string): Promise<CliResult> {
  const child = Bun.spawn(["npx", "--yes", "copilotkit@latest", ...args], {
    cwd: directory,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 120_000);
  try {
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      // CLI output can contain account or credential details. Never relay it to logs.
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout };
  } finally {
    clearTimeout(timeout);
  }
}

function verifiedContainer(
  result: CliResult,
  projectId: string,
  action: string,
) {
  const value = json(result.stdout);
  if (
    result.exitCode !== 0 ||
    value.schemaVersion !== 1 ||
    value.command !== `learning containers ${action}` ||
    value.status !== "success" ||
    value.projectId !== projectId ||
    !object(value.container) ||
    value.container.id !== "openbot" ||
    String(value.container.projectId) !== projectId
  ) {
    throw new Error(
      "The openbot container could not be verified in the selected project. Check Learning access in Intelligence, then run this helper again.",
    );
  }
}

function upsert(content: string, name: string, value: string) {
  const without = content
    .split(/\r?\n/)
    .filter(
      (line) => !new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line),
    )
    .join("\n");
  return `${without.replace(/\n*$/, "\n")}${name}=${JSON.stringify(value)}\n`;
}

/** Fresh managed setup only: this invocation owns key provisioning and proves its project. */
export async function setupLearning(
  options: {
    directory?: string;
    environment?: Record<string, string | undefined>;
    runCli?: RunCli;
  } = {},
): Promise<"configured" | "preserved"> {
  const directory = resolve(options.directory ?? process.cwd());
  const environment = options.environment ?? process.env;
  const run = options.runCli ?? runCli;
  const envPath = resolve(directory, ".env");
  const original = await readFile(envPath, "utf8").catch(() => {
    throw new Error(
      "Run this helper from the OpenBot root after copying .env.example to .env.",
    );
  });
  const values = parseEnv(original);
  const effective = (name: string) =>
    (environment[name] || values[name] || "").trim();
  if (effective(CONTAINER)) return "preserved";
  if (effective("INTELLIGENCE_API_KEY")) {
    throw new Error(
      "An OpenBot runtime key is already configured. It was preserved. Create a container in that key's Intelligence project and assign it in Admin → Automatic Learning; this helper cannot prove which project a manually supplied key belongs to.",
    );
  }
  if (effective("INTELLIGENCE_API_URL").replace(/\/$/, "") !== MANAGED_API) {
    throw new Error(
      "This helper provisions managed Intelligence only. For self-hosted or custom endpoints, create a container in that deployment and assign it in Admin → Automatic Learning.",
    );
  }
  const projectPath = resolve(directory, ".copilotkit/project.json");
  const selected = json(
    await readFile(projectPath, "utf8").catch(() => {
      throw new Error(
        "Run npx --yes copilotkit@latest login and project select from the OpenBot root first.",
      );
    }),
  );
  const projectId = selected.projectId;
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new Error(
      "The selected project is invalid. Run npx --yes copilotkit@latest project select again.",
    );
  }
  // A saved record alone does not prove a stale CPK key belongs to it. Re-provision here.
  // CLI project select removes INTELLIGENCE_API_KEY, hence the precondition above.
  const provision = await run(
    ["project", "select", "--project", projectId, "--json"],
    directory,
  );
  const selection = json(provision.stdout);
  if (
    provision.exitCode !== 0 ||
    selection.type !== "completed" ||
    selection.api_key_provisioned !== true ||
    selection.environment_file_written !== true ||
    !object(selection.project) ||
    selection.project.id !== projectId
  ) {
    throw new Error(
      "CopilotKit did not finish provisioning the selected project key. Sign in and run this helper again; no Learning assignment was saved.",
    );
  }
  const get = await run(
    ["learning", "containers", "get", "openbot", "--json"],
    directory,
  );
  const found = json(get.stdout);
  // The CLI reports ordinary absence in JSON; current releases exit zero for it.
  if (
    found.schemaVersion === 1 &&
    found.command === "learning containers get" &&
    found.status === "error" &&
    object(found.error) &&
    found.error.code === "LEARNING_CONTAINER_NOT_FOUND"
  ) {
    const created = await run(
      [
        "learning",
        "containers",
        "create",
        "--id",
        "openbot",
        "--name",
        "OpenBot",
        "--json",
      ],
      directory,
    );
    verifiedContainer(created, projectId, "create");
  } else verifiedContainer(get, projectId, "get");

  const current = await readFile(envPath, "utf8");
  const provisioned = parseEnv(current);
  const currentProject = json(await readFile(projectPath, "utf8"));
  if (
    currentProject.projectId !== projectId ||
    provisioned[CONTAINER] ||
    provisioned.INTELLIGENCE_API_KEY
  ) {
    throw new Error(
      "Setup configuration changed while provisioning. It was preserved; inspect .env and run this helper again.",
    );
  }
  const key = provisioned.CPK_INTELLIGENCE_API_KEY?.trim();
  if (!key?.startsWith("cpk-")) {
    throw new Error(
      "The CLI did not write a runtime key. Run project select and this helper again.",
    );
  }
  const content = upsert(
    upsert(current, "INTELLIGENCE_API_KEY", key),
    CONTAINER,
    "openbot",
  );
  const temporary = `${envPath}.learning-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, envPath);
  } finally {
    await rm(temporary, { force: true });
  }
  return "configured";
}

if (import.meta.main) {
  try {
    const result = await setupLearning();
    console.log(
      result === "configured"
        ? "Configured the selected project's openbot Learning container and OpenBot runtime key in .env. Saved Admin settings still take precedence."
        : "Preserved the existing Learning container assignment.",
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Learning setup failed; no assignment was saved.",
    );
    process.exitCode = 1;
  }
}

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";
import {
  type ContainerProbe,
  type KeyProject,
  keyProject,
  probeLearningContainer,
  runtimeKeyClient,
} from "../server/src/learning/auto-assign";
import {
  intelligenceApiOrigin,
  type LearningConnection,
  setupSelfHostedLearning,
} from "./self-hosted-learning";

const CONTAINER = "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID";
const MANAGED_API = "https://api.intelligence.copilotkit.ai";
type CliResult = { exitCode: number; stdout: string };
type RunCli = (args: string[], directory: string) => Promise<CliResult>;

/**
 * - `configured`: fresh setup wrote a runtime key and the container to `.env`.
 * - `preserved`: the environment already names a container.
 * - `present`: the runtime key's project already has `openbot`; the server assigns it.
 * - `created`: `openbot` was created in the runtime key's project; the server assigns it.
 * - `skipped`: run without a person (`--non-interactive`) and nothing can be done without one.
 */
export type SetupLearningResult =
  | "configured"
  | "preserved"
  | "present"
  | "created"
  | "skipped";

/** What the configured runtime key can answer about its own project. */
export type KeyIntelligence = {
  probe: (containerId: string) => Promise<ContainerProbe>;
  project: () => Promise<KeyProject | undefined>;
};

function keyIntelligence(
  apiUrl: string,
  apiKey: string,
  wsUrl?: string,
): KeyIntelligence {
  const client = runtimeKeyClient(apiUrl, apiKey, wsUrl);
  return {
    probe: (containerId) => probeLearningContainer(client, containerId),
    project: () => keyProject(client),
  };
}

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

async function saveEnvironment(envPath: string, content: string) {
  const temporary = `${envPath}.learning-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, envPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function interactiveSelfHosted(apiUrl: string, existingKey?: string) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  console.log("Sign in to Intelligence in the temporary browser window.");
  try {
    return await setupSelfHostedLearning({
      apiUrl,
      ...(existingKey ? { existingKey } : {}),
      signal: controller.signal,
      selectProject: async (projects, signal) => {
        if (projects.length === 1) return projects[0].id;
        const input = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          for (const [index, project] of projects.entries()) {
            console.log(`${index + 1}. ${project.name} (${project.id})`);
          }
          const answer = await input.question("Choose a project number: ", {
            signal,
          });
          const selected = projects[Number(answer.trim()) - 1];
          if (!selected)
            throw new Error("Select a project number from the list.");
          return selected.id;
        } finally {
          input.close();
        }
      },
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

function containerMissing(found: Record<string, unknown>) {
  // The CLI reports ordinary absence in JSON; current releases exit zero for it.
  return (
    found.schemaVersion === 1 &&
    found.command === "learning containers get" &&
    found.status === "error" &&
    object(found.error) &&
    found.error.code === "LEARNING_CONTAINER_NOT_FOUND"
  );
}

const CREATE_IN_INTELLIGENCE =
  'or create a Learning container with ID "openbot" in that project in Intelligence. OpenBot assigns it as the default on its next start.';

/**
 * A deployment that already has a runtime key: make sure that key's project has `openbot`.
 *
 * The key itself cannot create containers (Intelligence serves that only to a person's session or
 * CLI login), and it is never replaced here. It can say whether `openbot` exists in its project, and
 * which project that is, so creation goes through a person's credential only after the CLI's
 * selected project matches the key's, and counts only once the key itself can see the result. The
 * server then assigns it (learning/auto-assign.ts); nothing is written to `.env`.
 */
async function ensureForExistingKey(input: {
  directory: string;
  apiUrl: string;
  apiKey: string;
  nonInteractive: boolean;
  run: RunCli;
  key: KeyIntelligence;
  setupSelfHosted: (
    apiUrl: string,
    existingKey?: string,
  ) => Promise<LearningConnection>;
}): Promise<SetupLearningResult> {
  const found = await input.key.probe("openbot");
  if (found === "present") return "present";
  if (found === "not_entitled") {
    throw new Error(
      "This Intelligence project's plan does not include Learning. Nothing was created.",
    );
  }
  if (found === "unavailable") {
    throw new Error(
      "Intelligence could not be asked about the openbot Learning container with the configured runtime key. Check INTELLIGENCE_API_URL and INTELLIGENCE_API_KEY, then run this helper again.",
    );
  }
  let reused = false;
  if (input.apiUrl !== MANAGED_API) {
    // Self-hosted creation needs a browser sign-in, which only a person can complete.
    if (input.nonInteractive) return "skipped";
    const connection = await input.setupSelfHosted(input.apiUrl, input.apiKey);
    if (
      connection.apiKey !== input.apiKey ||
      connection.learningContainerId !== "openbot"
    ) {
      throw new Error(
        "Intelligence returned an invalid setup connection. Nothing was saved.",
      );
    }
  } else {
    const projectPath = resolve(input.directory, ".copilotkit/project.json");
    const text = await readFile(projectPath, "utf8").catch(() => undefined);
    if (text === undefined) {
      if (input.nonInteractive) return "skipped";
      throw new Error(
        `This runtime key's Intelligence project has no openbot Learning container, and no CopilotKit CLI project is selected here to create one with. Sign in with npx --yes copilotkit@latest login and select that project, ${CREATE_IN_INTELLIGENCE}`,
      );
    }
    const selected = json(text);
    const projectId = selected.projectId;
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error(
        "The selected project is invalid. Run npx --yes copilotkit@latest project select again.",
      );
    }
    const owner = await input.key.project();
    if (
      !owner ||
      typeof selected.projectSlug !== "string" ||
      selected.projectSlug !== owner.projectSlug
    ) {
      throw new Error(
        `The CopilotKit CLI's selected project could not be confirmed as the one this runtime key belongs to, so nothing was created. Select the key's project in the CLI, ${CREATE_IN_INTELLIGENCE}`,
      );
    }
    const get = await input.run(
      ["learning", "containers", "get", "openbot", "--json"],
      input.directory,
    );
    if (containerMissing(json(get.stdout))) {
      verifiedContainer(
        await input.run(
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
          input.directory,
        ),
        projectId,
        "create",
      );
    } else {
      verifiedContainer(get, projectId, "get");
      reused = true;
    }
  }
  // The check that matters, whatever the project match said: can the key see it now?
  if ((await input.key.probe("openbot")) !== "present") {
    throw new Error(
      reused
        ? "The CLI's selected project has an openbot container, but this runtime key cannot see it, so the key belongs to another project. Nothing was assigned."
        : "Created an openbot container, but this runtime key still cannot see it, so it is in another project. Nothing was assigned; remove that container in Intelligence if it is not wanted.",
    );
  }
  return reused ? "present" : "created";
}

/** Fresh setup owns key provisioning, so its container and key share a verified project. */
export async function setupLearning(
  options: {
    directory?: string;
    environment?: Record<string, string | undefined>;
    runCli?: RunCli;
    setupSelfHosted?: (
      apiUrl: string,
      existingKey?: string,
    ) => Promise<LearningConnection>;
    /** No browser, no prompt and no new key: what `scripts/start.sh` runs on every start. */
    nonInteractive?: boolean;
    keyIntelligence?: (
      apiUrl: string,
      apiKey: string,
      wsUrl?: string,
    ) => KeyIntelligence;
  } = {},
): Promise<SetupLearningResult> {
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
  const existingKey = effective("INTELLIGENCE_API_KEY");
  if (existingKey) {
    const apiUrl = intelligenceApiOrigin(effective("INTELLIGENCE_API_URL"));
    return ensureForExistingKey({
      directory,
      apiUrl,
      apiKey: existingKey,
      nonInteractive: options.nonInteractive === true,
      run,
      key: (options.keyIntelligence ?? keyIntelligence)(
        apiUrl,
        existingKey,
        effective("INTELLIGENCE_GATEWAY_WS_URL") || undefined,
      ),
      setupSelfHosted: options.setupSelfHosted ?? interactiveSelfHosted,
    });
  }
  // Provisioning a key edits .env and may need a browser: a person runs that, not a start script.
  if (options.nonInteractive) return "skipped";
  const apiUrl = intelligenceApiOrigin(effective("INTELLIGENCE_API_URL"));
  if (apiUrl !== MANAGED_API) {
    const connection = await (options.setupSelfHosted ?? interactiveSelfHosted)(
      apiUrl,
    );
    if (
      connection.apiUrl !== apiUrl ||
      connection.learningContainerId !== "openbot" ||
      !connection.apiKey.startsWith("cpk-")
    ) {
      throw new Error(
        "Intelligence returned an invalid setup connection. Nothing was saved.",
      );
    }
    const current = await readFile(envPath, "utf8");
    if (current !== original) {
      throw new Error(
        "Setup configuration changed while signing in. It was preserved; inspect .env and run this helper again.",
      );
    }
    await saveEnvironment(
      envPath,
      upsert(
        upsert(
          upsert(current, "INTELLIGENCE_API_URL", apiUrl),
          "INTELLIGENCE_API_KEY",
          connection.apiKey,
        ),
        CONTAINER,
        connection.learningContainerId,
      ),
    );
    return "configured";
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
  if (containerMissing(json(get.stdout))) {
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
  await saveEnvironment(envPath, content);
  return "configured";
}

const RESULT_MESSAGES: Record<SetupLearningResult, string> = {
  configured:
    "Configured the selected project's openbot Learning container and OpenBot runtime key in .env. Saved Admin settings still take precedence.",
  preserved: "Preserved the existing Learning container assignment.",
  present:
    "This runtime key's project has the openbot Learning container. OpenBot assigns it as the default on start unless Admin → Automatic Learning has a saved setting.",
  created:
    "Created the openbot Learning container in this runtime key's project. OpenBot assigns it as the default on start unless Admin → Automatic Learning has a saved setting.",
  skipped:
    'Automatic Learning: no openbot container was created, because that needs a person to sign in. Run bun scripts/setup-learning.ts, or create a Learning container with ID "openbot" in Intelligence.',
};

if (import.meta.main) {
  const nonInteractive = process.argv.slice(2).includes("--non-interactive");
  try {
    console.log(RESULT_MESSAGES[await setupLearning({ nonInteractive })]);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Learning setup failed; no assignment was saved.";
    // Run by scripts/start.sh, a failure here must not stop OpenBot starting: say it and move on.
    if (nonInteractive) console.log(`Automatic Learning: ${message}`);
    else {
      console.error(message);
      process.exitCode = 1;
    }
  }
}

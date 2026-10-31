import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";
import {
  cliLoginPresent,
  containerMissing,
  ensureLearningContainer,
  json,
  type KeyIntelligence,
  keyIntelligence,
  learningSetupInstructions,
  MANAGED_API,
  object,
  type RunCli,
  runCli,
  verifiedContainer,
} from "../server/src/learning/ensure-container";
import { intelligenceApiKey } from "../shared/intelligence-key";
import {
  intelligenceApiOrigin,
  type LearningConnection,
  setupSelfHostedLearning,
} from "./self-hosted-learning";

export type { KeyIntelligence } from "../server/src/learning/ensure-container";

const CONTAINER = "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID";

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
    /**
     * Whether a CopilotKit CLI login may be on this machine. False skips the CLI entirely, so a
     * start on a machine that never signed in does not download it. Unset means try it.
     */
    cliLogin?: boolean;
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
  const existingKey = intelligenceApiKey({
    CPK_INTELLIGENCE_API_KEY: effective("CPK_INTELLIGENCE_API_KEY"),
    INTELLIGENCE_API_KEY: effective("INTELLIGENCE_API_KEY"),
  });
  if (existingKey) {
    /*
     * The key cannot create containers, and it is never replaced here. Creation goes through a
     * credential that can (learning/ensure-container.ts) and counts only once the key itself can see
     * the result. The server then assigns it; nothing is written to `.env`.
     */
    const apiUrl = intelligenceApiOrigin(effective("INTELLIGENCE_API_URL"));
    const serviceToken = effective("INTELLIGENCE_SERVICE_TOKEN");
    const projectId = effective("INTELLIGENCE_PROJECT_ID");
    const setupSelfHosted = options.setupSelfHosted ?? interactiveSelfHosted;
    return ensureLearningContainer({
      directory,
      apiUrl,
      nonInteractive: options.nonInteractive === true,
      run,
      key: (options.keyIntelligence ?? keyIntelligence)(
        apiUrl,
        existingKey,
        effective("INTELLIGENCE_GATEWAY_WS_URL") || undefined,
      ),
      ...(serviceToken && projectId
        ? { serviceToken: { token: serviceToken, projectId } }
        : {}),
      ...(options.cliLogin === undefined ? {} : { cliLogin: options.cliLogin }),
      setupSelfHosted: async () => {
        const connection = await setupSelfHosted(apiUrl, existingKey);
        if (
          connection.apiKey !== existingKey ||
          connection.learningContainerId !== "openbot"
        ) {
          throw new Error(
            "Intelligence returned an invalid setup connection. Nothing was saved.",
          );
        }
      },
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
  // No runtime key is available. Provision one for the saved project before assigning Learning.
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
  const content = upsert(current, CONTAINER, "openbot");
  await saveEnvironment(envPath, content);
  return "configured";
}

const RESULT_MESSAGES: Record<
  Exclude<SetupLearningResult, "skipped">,
  string
> = {
  configured:
    "Configured the selected project's openbot Learning container and OpenBot runtime key in .env. Saved Admin settings still take precedence.",
  preserved: "Preserved the existing Learning container assignment.",
  present:
    "This runtime key's project has the openbot Learning container. OpenBot assigns it as the default on start unless Admin → Automatic Learning has a saved setting.",
  created:
    "Created the openbot Learning container in this runtime key's project. OpenBot assigns it as the default on start unless Admin → Automatic Learning has a saved setting.",
};

/** What to run instead, for the Intelligence this checkout points at. */
async function skippedMessage(directory: string) {
  const values = parseEnv(
    await readFile(resolve(directory, ".env"), "utf8").catch(() => ""),
  );
  let apiUrl = MANAGED_API;
  try {
    apiUrl = intelligenceApiOrigin(
      (
        process.env.INTELLIGENCE_API_URL ||
        values.INTELLIGENCE_API_URL ||
        MANAGED_API
      ).trim(),
    );
  } catch {}
  return `Automatic Learning: no openbot container was created, because nothing here can create one without a person. ${learningSetupInstructions(apiUrl)}`;
}

if (import.meta.main) {
  const nonInteractive = process.argv.slice(2).includes("--non-interactive");
  try {
    const result = await setupLearning({
      nonInteractive,
      // A start script on a machine that never signed in should not download the CLI to find out.
      ...(nonInteractive ? { cliLogin: cliLoginPresent() } : {}),
    });
    console.log(
      result === "skipped"
        ? await skippedMessage(process.cwd())
        : RESULT_MESSAGES[result],
    );
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

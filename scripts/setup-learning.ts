import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";
import {
  cmdLineSafe,
  ensureLearningContainer,
  json,
  type KeyIntelligence,
  keyIntelligence,
  MANAGED_API,
  npxCommand,
  object,
  type RunCli,
  runCli,
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
 */
export type SetupLearningResult =
  | "configured"
  | "preserved"
  | "present"
  | "created";

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
  const keyFor = (apiUrl: string, apiKey: string) =>
    (options.keyIntelligence ?? keyIntelligence)(
      apiUrl,
      apiKey,
      effective("INTELLIGENCE_GATEWAY_WS_URL") || undefined,
    );
  if (existingKey) {
    // The key creates the container in its own project, and is never replaced here. Nothing is
    // written to `.env`: the server assigns the container on its own.
    const apiUrl = intelligenceApiOrigin(effective("INTELLIGENCE_API_URL"));
    return ensureLearningContainer({ key: keyFor(apiUrl, existingKey) });
  }
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
  // Through cmd.exe, `runCli` refuses such an id without running anything; say so here instead.
  if (npxCommand().shell && !cmdLineSafe([projectId])) {
    throw new Error(
      "The selected project id has characters that cannot be passed safely to the CopilotKit CLI on Windows. Run npx --yes copilotkit@latest project select again.",
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
  // The new key makes the container in the project it was provisioned for.
  await ensureLearningContainer({ key: keyFor(apiUrl, key) });
  const content = upsert(current, CONTAINER, "openbot");
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
};

if (import.meta.main) {
  try {
    console.log(RESULT_MESSAGES[await setupLearning()]);
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Learning setup failed; no assignment was saved.",
    );
    process.exitCode = 1;
  }
}

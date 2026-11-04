import { chmod, link, open, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  type CliResult,
  cmdLineSafe,
  npxCommand,
  object,
  type RunCli,
  runCli,
} from "../server/src/learning/ensure-container";

const IDENTITY = "OPENBOT_INSTALLATION_ID";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVISIONING_ERROR =
  "Composio project setup did not complete. Sign in with npx --yes copilotkit@latest login, then run bun run setup:composio again. Use a CLI release that supports integrations composio provision and a CopilotKit deployment with the hosted provisioning service enabled; check network access. If .env.composio.lock remains after an interruption, remove it only after confirming no provision command is running. The saved installation identity will be reused.";

class SetupComposioError extends Error {}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Publish a complete private identity once, before starting any remote operation. */
async function installationIdentity(directory: string, requested: string) {
  requested = requested.toLowerCase();
  const path = resolve(directory, ".env.openbot-installation-id");
  if (requested && !UUID.test(requested)) {
    throw new SetupComposioError(
      "OPENBOT_INSTALLATION_ID must be a UUID. Fix this installation identity before retrying setup.",
    );
  }
  try {
    let content: string | undefined;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    if (content === undefined) {
      const temporary = `${path}.${crypto.randomUUID()}`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(
            `${IDENTITY}=${requested || crypto.randomUUID()}\n`,
          );
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          // Unlike rename, link cannot overwrite a winner from a concurrent setup process.
          await link(temporary, path);
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
        }
      } finally {
        await rm(temporary, { force: true });
      }
      content = await readFile(path, "utf8");
    }
    const id = parseEnv(content)[IDENTITY]?.toLowerCase();
    if (!id || !UUID.test(id)) {
      throw new SetupComposioError(
        "The saved installation identity in .env.openbot-installation-id is invalid. Restore its original OPENBOT_INSTALLATION_ID UUID before retrying; do not generate another identity for an existing installation.",
      );
    }
    if (requested && requested !== id) {
      throw new SetupComposioError(
        "OPENBOT_INSTALLATION_ID does not match the saved installation identity in .env.openbot-installation-id. Restore the original UUID before retrying setup.",
      );
    }
    await chmod(path, 0o600);
    return id;
  } catch (error) {
    if (error instanceof SetupComposioError) throw error;
    throw new SetupComposioError(
      "Could not persist the private installation identity in .env.openbot-installation-id. Check directory permissions and filesystem hard-link support, then retry. No provisioning request was started.",
    );
  }
}

async function readEnvironment(path: string) {
  try {
    return parseEnv(await readFile(path, "utf8"));
  } catch {
    throw new SetupComposioError(
      "Could not read .env. Run this helper from the OpenBot root after copying .env.example to .env, and check file permissions.",
    );
  }
}

/** Uses only the CLI login; no parent Composio organization credential reaches OpenBot. */
export async function setupComposio(
  options: {
    directory?: string;
    environment?: NodeJS.ProcessEnv;
    runCli?: RunCli;
  } = {},
): Promise<"configured" | "preserved"> {
  const directory = resolve(options.directory ?? process.cwd());
  const environment = options.environment ?? process.env;
  const envPath = resolve(directory, ".env");
  const values = await readEnvironment(envPath);
  const effective = (name: string) =>
    environment[name]?.trim() || values[name]?.trim() || "";
  // A blank exported value must never cause a supplied file key to be replaced.
  if (effective("COMPOSIO_API_KEY")) return "preserved";
  const provider = effective("OPENBOT_BROKER_PROVIDER").toLowerCase();
  if (provider === "arcade" || (!provider && effective("ARCADE_API_KEY")))
    return "preserved";
  if (provider && provider !== "composio") {
    throw new SetupComposioError(
      "OPENBOT_BROKER_PROVIDER must be composio or arcade. Fix it before running Composio setup.",
    );
  }

  const id = await installationIdentity(directory, effective(IDENTITY));
  // The existing sanitized runner rejects arguments cmd.exe could execute. Forward slashes are
  // valid in a Windows path and avoid treating a normal drive path as a shell expression.
  const cliPath =
    process.platform === "win32" ? envPath.replaceAll("\\", "/") : envPath;
  const args = [
    "integrations",
    "composio",
    "provision",
    "--installation-id",
    id,
    "--env-path",
    cliPath,
    "--json",
  ];
  if (npxCommand().shell && !cmdLineSafe(args)) {
    throw new SetupComposioError(
      "The CopilotKit CLI cannot safely receive this checkout's path through the Windows shell. Use a checkout path without spaces or shell special characters, then run bun run setup:composio again with the saved installation identity.",
    );
  }
  let response: CliResult;
  try {
    response = await (options.runCli ?? runCli)(args, directory);
  } catch {
    // A thrown child error can include credentials or account details; never relay it.
    throw new SetupComposioError(PROVISIONING_ERROR);
  }
  if (response.exitCode === 127) {
    throw new SetupComposioError(
      "Composio setup could not start npx. Install Node.js with npx on PATH, then sign in with npx --yes copilotkit@latest login and run bun run setup:composio again. The saved installation identity will be reused.",
    );
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(response.stdout);
  } catch {
    throw new SetupComposioError(PROVISIONING_ERROR);
  }
  if (
    response.exitCode !== 0 ||
    !object(metadata) ||
    metadata.installation_id !== id
  ) {
    throw new SetupComposioError(PROVISIONING_ERROR);
  }
  const configured = metadata.type === "completed";
  const fields = configured
    ? [
        "type",
        "installation_id",
        "project_id",
        "environment_file_written",
        "reused",
      ]
    : ["type", "installation_id", "environment_file_written"];
  if (
    Object.keys(metadata).length !== fields.length ||
    !Object.keys(metadata).every((name) => fields.includes(name)) ||
    (configured
      ? typeof metadata.project_id !== "string" ||
        !metadata.project_id.trim() ||
        metadata.environment_file_written !== true ||
        typeof metadata.reused !== "boolean"
      : metadata.type !== "already_configured" ||
        metadata.environment_file_written !== false)
  ) {
    throw new SetupComposioError(PROVISIONING_ERROR);
  }
  const saved = await readEnvironment(envPath);
  if (!saved.COMPOSIO_API_KEY?.trim()) {
    throw new SetupComposioError(
      "CopilotKit did not write a Composio project key to .env. Check file permissions and run bun run setup:composio again; the saved installation identity will be reused.",
    );
  }
  // Bun read .env when this process started. Reload only the key the CLI was asked to write.
  environment.COMPOSIO_API_KEY = saved.COMPOSIO_API_KEY;
  return configured ? "configured" : "preserved";
}

if (import.meta.main) {
  try {
    const result = await setupComposio();
    console.log(
      result === "configured"
        ? "Composio: project key configured in .env."
        : "Composio: existing broker configuration preserved.",
    );
  } catch (error) {
    console.error(
      error instanceof SetupComposioError
        ? error.message
        : "Composio setup failed. Run bun run setup:composio again after checking file permissions and CLI sign-in.",
    );
    process.exitCode = 1;
  }
}

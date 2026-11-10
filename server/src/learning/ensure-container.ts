/**
 * Create this project's `openbot` Learning container with whatever credential can.
 *
 * THE RUNTIME KEY FIRST. A current Intelligence creates a container in the key's own project on
 * `POST /api/v1/learning/containers`, and nothing else is needed. Intelligence 0.15.1 and earlier
 * have no such route (404), and serve `POST /api/learning/projects/:projectId/containers` to three
 * callers only: a person's browser session (from a trusted origin), a CopilotKit CLI login
 * (exchanged for a fifteen-minute product credential), and a service token, which counts only on a
 * CopilotKit local evaluation install. So on those, every path below goes through one of the three,
 * and each proves its result with the runtime key afterwards: a container the key still cannot see
 * is in another project, and is reported rather than assigned.
 *
 * - A service token (INTELLIGENCE_SERVICE_TOKEN with INTELLIGENCE_PROJECT_ID), on any Intelligence:
 *   Intelligence decides whether it counts.
 * - A CLI login against managed Intelligence. With a project selected in this directory, the
 *   selected project is used once it matches the key's. Without one, the projects the login can see
 *   are listed and the key's is chosen by slug, in a scratch directory, so nothing here is selected
 *   or rewritten.
 * - A browser sign-in against self-hosted Intelligence, which only a person can complete, so only
 *   when somebody is there (`scripts/setup-learning.ts`).
 *
 * Shared by `scripts/setup-learning.ts` (run by `scripts/start.sh`), the server (at boot and from
 * Admin → Automatic Learning), and the Helm chart's setup Job, which runs this file directly. The
 * server also makes each person's own Learning space with the same credential (`createLearningContainer`,
 * called by learning/personal-space.ts).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { intelligenceApiKey } from "@openbot/shared/intelligence-key";
import { transientStatus } from "../intelligence-startup";
import {
  type ContainerProbe,
  type KeyIdentity,
  keyIdentity,
  probeLearningContainer,
  runtimeKeyClient,
} from "./auto-assign";

export const MANAGED_API = "https://api.intelligence.copilotkit.ai";
const SERVICE_TOKEN_HEADER = "x-copilotkit-ei-service-token";

/** A Learning container to create: its id (Intelligence's 1 to 64 lowercase letters, digits and single hyphens) and name. */
export type LearningContainerSpec = { id: string; name: string };
/** The project's shared default, which Automatic Learning assigns. */
export const OPENBOT_CONTAINER: LearningContainerSpec = {
  id: "openbot",
  name: "OpenBot",
};

export type CliResult = { exitCode: number; stdout: string };
export type RunCli = (args: string[], directory: string) => Promise<CliResult>;

/** What the configured runtime key can answer about its own project, and do in it. */
export type KeyIntelligence = {
  probe: (containerId: string) => Promise<ContainerProbe>;
  project: () => Promise<KeyIdentity | undefined>;
  /**
   * Create `container` in the key's own project. `unsupported`: this Intelligence has no such route
   * for a project key, so another credential has to.
   */
  create?: (
    container: LearningContainerSpec,
  ) => Promise<"created" | "present" | "unsupported">;
};

export function keyIntelligence(
  apiUrl: string,
  apiKey: string,
  wsUrl?: string,
  fetchImpl: typeof fetch = fetch,
): KeyIntelligence {
  const client = runtimeKeyClient(apiUrl, apiKey, wsUrl);
  return {
    probe: (containerId) => probeLearningContainer(client, containerId),
    project: () => keyIdentity(client),
    create: (container) =>
      createWithRuntimeKey({ apiUrl, apiKey, fetch: fetchImpl, container }),
  };
}

/**
 * Create a container with the runtime key, in the project Intelligence reads off that key: the body
 * names no project, so the key cannot make one anywhere else.
 *
 * 201 is a new container and 200 the one already stored under that id, unchanged, so replicas and
 * people racing to ensure the same container all end with it. A 409 from an Intelligence that
 * reports a taken id instead is present too. 404 is an Intelligence without the route (0.15.1 and
 * earlier, or Learning switched off), and the caller tries its other credentials. A failure that may
 * pass in a moment (nothing answering, a 5xx, a 408 or 429) is thrown marked `retryable`, which the
 * server's automatic assignment reads as Intelligence still starting rather than as its one try.
 */
export async function createWithRuntimeKey(input: {
  apiUrl: string;
  apiKey: string;
  fetch: typeof fetch;
  container: LearningContainerSpec;
}): Promise<"created" | "present" | "unsupported"> {
  const { container } = input;
  let response: Response;
  try {
    response = await input.fetch(
      `${input.apiUrl.replace(/\/+$/, "")}/api/v1/learning/containers`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: container.id, name: container.name }),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (error) {
    throw Object.assign(
      new Error(
        `The backend did not answer the runtime key's request to create the ${container.id} Learning container (${error instanceof Error ? error.message : String(error)}).`,
      ),
      { retryable: true },
    );
  }
  const body: unknown = await response.json().catch(() => null);
  const code =
    object(body) && object(body.error) && typeof body.error.code === "string"
      ? body.error.code
      : undefined;
  if (response.status === 201 || response.status === 200) {
    if (
      object(body) &&
      object(body.container) &&
      body.container.id === container.id
    )
      return response.status === 201 ? "created" : "present";
    throw new Error(
      `The backend answered the runtime key's container request with something other than the ${container.id} container. Nothing was assigned.`,
    );
  }
  if (response.status === 409 && code === "LEARNING_CONTAINER_ALREADY_EXISTS")
    return "present";
  if (response.status === 404) return "unsupported";
  if (code === "LEARNING_NOT_ENABLED")
    throw new Error(
      "The backend's licence does not include Learning, so no container was created.",
    );
  throw Object.assign(
    new Error(
      `The backend could not create the ${container.id} Learning container with the runtime key (HTTP ${response.status}${code ? `, ${code}` : ""}). OpenBot tries again.`,
    ),
    { retryable: transientStatus(response.status) },
  );
}

/** `present`: it was already there. `created`: made here. `skipped`: nothing here could make it. */
export type EnsureContainerResult = "present" | "created" | "skipped";

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function json(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (object(value)) return value;
  } catch {}
  throw new Error(
    "CopilotKit returned an invalid setup response. No Learning assignment was saved.",
  );
}

/** An Intelligence API origin: HTTPS, or HTTP on a loopback address, and nothing after the host. */
export function intelligenceApiOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter the backend's API origin as a complete URL.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  ) {
    throw new Error(
      "Use an HTTPS backend API origin, or HTTP on localhost for local development. Paths and embedded credentials are not supported.",
    );
  }
  return url.origin;
}

/**
 * The environment the CLI runs with: where it finds its login and how it reaches npm, and nothing
 * else. It is `copilotkit@latest` from the registry, so it never sees this process's secrets.
 */
const CLI_ENVIRONMENT =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TEMP|TMP|LANG|LC_[A-Z]+|XDG_[A-Z_]+|APPDATA|LOCALAPPDATA|USERPROFILE|SYSTEMROOT|SystemRoot|COMSPEC|PATHEXT|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|NODE_EXTRA_CA_CERTS|npm_config_[a-z_]+|NPM_CONFIG_[A-Z_]+|COPILOTKIT_CONFIG_DIR|COPILOTKIT_DEPLOYMENT|COPILOTKIT_APP_API_URL|COPILOTKIT_OPS_API_URL|COPILOTKIT_TELEMETRY_DISABLED)$/;

export function cliEnvironment(
  environment: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const kept: Record<string, string> = { COPILOTKIT_TELEMETRY_DISABLED: "1" };
  for (const [name, value] of Object.entries(environment))
    if (value !== undefined && CLI_ENVIRONMENT.test(name)) kept[name] = value;
  return kept;
}

/**
 * How to start `npx` on a platform. Windows ships it as `npx.cmd`, and since CVE-2024-27980 Node and
 * Bun refuse to spawn a `.cmd` without a shell: `spawn` throws EINVAL before anything runs.
 */
export function npxCommand(platform: NodeJS.Platform = process.platform): {
  command: string;
  shell: boolean;
} {
  return platform === "win32"
    ? { command: "npx.cmd", shell: true }
    : { command: "npx", shell: false };
}

/**
 * Whether every argument reaches the program as written through `cmd.exe`. The shell joins them into
 * one unquoted command line, so `&` or `|` in one would start another command and `%` would expand a
 * variable. Not every argument is a literal: `setup-learning.ts` passes the project id it reads from
 * `.copilotkit/project.json`.
 */
export function cmdLineSafe(args: string[]): boolean {
  return args.every((arg) => /^[A-Za-z0-9@._:/+-]+$/.test(arg));
}

/**
 * `child.kill()` on Windows ends `cmd.exe` and leaves the command under it running, holding the
 * pipes, so `close` waits for that command however long it takes. `taskkill /T` ends the tree.
 * Once `cmd.exe` has exited its id may belong to another process, so it is not used after that.
 */
export function stopProcessTree(child: ChildProcess, shell: boolean): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!shell || child.pid === undefined) {
    child.kill();
    return;
  }
  // By full path: a bare name is looked up in the working directory first.
  const taskkill = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
  spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
  })
    .on("error", () => child.kill())
    .on("exit", (code) => {
      if (code !== 0) child.kill();
    });
}

/** Run `npx <args>` in `directory`, for at most two minutes. */
export const runNpx = (args: string[], directory: string): Promise<CliResult> =>
  new Promise((resolvePromise) => {
    const { command, shell } = npxCommand();
    if (shell && !cmdLineSafe(args)) {
      resolvePromise({ exitCode: 1, stdout: "" });
      return;
    }
    const child = spawn(command, args, {
      cwd: directory,
      env: cliEnvironment(),
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 1_048_576) stdout += chunk;
    });
    // CLI output on stderr can carry account or credential details. Never relay it.
    child.stderr.resume();
    const timeout = setTimeout(() => stopProcessTree(child, shell), 120_000);
    const finish = (exitCode: number) => {
      clearTimeout(timeout);
      resolvePromise({ exitCode, stdout });
    };
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });

/** Run `npx --yes copilotkit@latest <args>` in `directory`, for at most two minutes. */
export const runCli: RunCli = (args, directory) =>
  runNpx(["--yes", "copilotkit@latest", ...args], directory);

/**
 * Whether a CopilotKit CLI login is on this machine, without running the CLI.
 *
 * Where the CLI's own store (`conf`, project `copilotkit-auth`) keeps it: under COPILOTKIT_CONFIG_DIR
 * when that names a folder, otherwise the platform's config directory. Only a hint, so the server does
 * not download the CLI on every boot of a container that has never signed in; the CLI is still the
 * one that decides.
 */
export function cliLoginPresent(
  environment: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): boolean {
  const override = environment.COPILOTKIT_CONFIG_DIR?.trim();
  const candidates =
    override && isAbsolute(override)
      ? [join(override, "auth", "config.json")]
      : platform === "darwin"
        ? [join(home, "Library/Preferences/copilotkit-auth-nodejs/config.json")]
        : platform === "win32"
          ? [
              join(
                environment.APPDATA ?? join(home, "AppData/Roaming"),
                "copilotkit-auth-nodejs/Config/config.json",
              ),
            ]
          : [
              join(
                environment.XDG_CONFIG_HOME || join(home, ".config"),
                "copilotkit-auth-nodejs/config.json",
              ),
            ];
  return candidates.some((path) => existsSync(path));
}

export function verifiedContainer(
  result: CliResult,
  projectId: string,
  action: string,
  containerId: string = OPENBOT_CONTAINER.id,
) {
  const value = json(result.stdout);
  if (
    result.exitCode !== 0 ||
    value.schemaVersion !== 1 ||
    value.command !== `learning containers ${action}` ||
    value.status !== "success" ||
    value.projectId !== projectId ||
    !object(value.container) ||
    value.container.id !== containerId ||
    String(value.container.projectId) !== projectId
  ) {
    throw new Error(
      `The ${containerId} container could not be verified in the selected project. Check Learning access in the backend dashboard, then run this helper again.`,
    );
  }
}

export function containerMissing(found: Record<string, unknown>) {
  // The CLI reports ordinary absence in JSON; current releases exit zero for it.
  return (
    found.schemaVersion === 1 &&
    found.command === "learning containers get" &&
    found.status === "error" &&
    object(found.error) &&
    found.error.code === "LEARNING_CONTAINER_NOT_FOUND"
  );
}

export const CREATE_IN_INTELLIGENCE =
  'or create a Learning container with ID "openbot" in that project in the backend dashboard. OpenBot assigns it as the default on its next start.';

/**
 * Exactly what an operator runs when nothing here could create the container. One sentence set,
 * shared by the server log, Admin → Automatic Learning and the setup Job, so all three say the same.
 */
export function learningSetupInstructions(apiUrl: string): string {
  const create =
    'Or create a Learning container with ID "openbot" in this project in the backend dashboard. OpenBot assigns it within ten minutes either way.';
  return apiUrl === MANAGED_API
    ? `Sign in once with npx --yes copilotkit@latest login, then run bun scripts/setup-learning.ts from the OpenBot checkout (bun run start does this too). On Kubernetes, put that login in a Secret and name it in config.learning.setup.cliLoginSecret; the chart's setup Job creates the container. ${create}`
    : `Run bun scripts/setup-learning.ts from the OpenBot checkout and sign in to CopilotKit in the browser it opens. On a CopilotKit local evaluation install, set INTELLIGENCE_SERVICE_TOKEN and INTELLIGENCE_PROJECT_ID instead and OpenBot creates it by itself. ${create}`;
}

/**
 * Create the container with a service token. Intelligence admits one only on local evaluation. Idempotent: an id that is
 * already taken in the project is `present`, so replicas racing to create the same container all end up with it.
 */
async function createWithServiceToken(input: {
  apiUrl: string;
  serviceToken: { token: string; projectId: string };
  fetch: typeof fetch;
  container: LearningContainerSpec;
}): Promise<"created" | "present"> {
  const { container } = input;
  const response = await input.fetch(
    `${input.apiUrl}/api/learning/projects/${encodeURIComponent(input.serviceToken.projectId)}/containers`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        [SERVICE_TOKEN_HEADER]: input.serviceToken.token,
      },
      body: JSON.stringify({ id: container.id, name: container.name }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 201) {
    if (
      object(body) &&
      object(body.container) &&
      body.container.id === container.id &&
      String(body.container.projectId) === input.serviceToken.projectId
    )
      return "created";
    throw new Error(
      `The backend answered the service token's container request with something other than the ${container.id} container. Nothing was assigned.`,
    );
  }
  if (
    response.status === 409 &&
    object(body) &&
    object(body.error) &&
    body.error.code === "LEARNING_CONTAINER_ALREADY_EXISTS"
  )
    return "present";
  if (response.status === 401 || response.status === 403)
    throw new Error(
      "The backend refused the service token for Learning. Service tokens create Learning containers only on a CopilotKit local evaluation install; anywhere else, sign in instead (bun scripts/setup-learning.ts).",
    );
  throw new Error(
    `The backend could not create the ${container.id} Learning container with the service token (HTTP ${response.status}). Nothing was assigned.`,
  );
}

/** One project the CLI login can see, as `copilotkit project list --json` prints it. */
type ListedProject = {
  id: string;
  slug: string;
  name: string;
  organizationId: string;
};

/** The projects in the CLI login's active organization, and that organization's Clerk ID. */
function listedProjects(
  result: CliResult,
): { organizationId: string; projects: ListedProject[] } | undefined {
  if (result.exitCode !== 0) return undefined;
  let value: Record<string, unknown>;
  try {
    value = json(result.stdout);
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(value.projects) ||
    typeof value.organizationId !== "string"
  )
    return undefined;
  return {
    organizationId: value.organizationId,
    projects: value.projects.flatMap((project) =>
      object(project) &&
      typeof project.id === "string" &&
      typeof project.slug === "string" &&
      typeof project.name === "string" &&
      typeof project.organizationId === "string"
        ? [
            {
              id: project.id,
              slug: project.slug,
              name: project.name,
              organizationId: project.organizationId,
            },
          ]
        : [],
    ),
  };
}

/** The CLI login's active organization, by name and Clerk ID, from `copilotkit whoami`. */
async function loginOrganization(
  run: RunCli,
  directory: string,
): Promise<{ name: string; clerkOrgId: string } | undefined> {
  const result = await run(["whoami"], directory);
  if (result.exitCode !== 0) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colour codes.
  const text = result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const name = /^Organization:[ \t]*(.+)$/m.exec(text)?.[1]?.trim();
  const clerkOrgId = /^Clerk Org ID:[ \t]*(.+)$/m.exec(text)?.[1]?.trim();
  return name && clerkOrgId ? { name, clerkOrgId } : undefined;
}

/**
 * The project to create in, proven to be the runtime key's BEFORE anything is written: the login's
 * active organization must carry the key's organization name (the CLI never reports a slug), and the
 * project must be the one there with the key's slug and name, and the selected one when one is. Any
 * doubt is undefined, and nothing is created. The key's own probe after the write still decides.
 */
function keysProject(
  owner: KeyIdentity | undefined,
  organization: { name: string; clerkOrgId: string } | undefined,
  listing: { organizationId: string; projects: ListedProject[] },
  selectedId?: string,
): ListedProject | undefined {
  if (!owner || !organization) return undefined;
  if (
    organization.clerkOrgId !== listing.organizationId ||
    organization.name !== owner.organizationName
  )
    return undefined;
  const matches = listing.projects.filter(
    (project) =>
      project.organizationId === listing.organizationId &&
      project.slug === owner.projectSlug &&
      project.name === owner.projectName &&
      (selectedId === undefined || project.id === selectedId),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Get the container, or create it when the get says it is missing. True when it was already there. */
async function getOrCreate(
  run: RunCli,
  directory: string,
  projectId: string,
  container: LearningContainerSpec,
): Promise<boolean> {
  const getIt = () =>
    run(["learning", "containers", "get", container.id, "--json"], directory);
  const get = await getIt();
  if (containerMissing(json(get.stdout))) {
    try {
      verifiedContainer(
        await run(
          [
            "learning",
            "containers",
            "create",
            "--id",
            container.id,
            "--name",
            container.name,
            "--json",
          ],
          directory,
        ),
        projectId,
        "create",
        container.id,
      );
      return false;
    } catch (error) {
      // Another replica may have created it between the get and the create: if it is there now, it is present.
      const again = await getIt();
      if (containerMissing(json(again.stdout))) throw error;
      verifiedContainer(again, projectId, "get", container.id);
      return true;
    }
  }
  verifiedContainer(get, projectId, "get", container.id);
  return true;
}

/** The credentials `createLearningContainer` may use, and where it runs. */
export type LearningContainerCredentials = {
  directory: string;
  apiUrl: string;
  nonInteractive: boolean;
  key: KeyIntelligence;
  run?: RunCli;
  serviceToken?: { token: string; projectId: string };
  fetch?: typeof fetch;
  /** A person's browser sign-in against self-hosted Intelligence. Only `setup-learning.ts` has one. */
  setupSelfHosted?: () => Promise<void>;
  /** Whether to try the CLI when nobody is there. Default true; the server passes `cliLoginPresent()`. */
  cliLogin?: boolean;
};

/**
 * Create `container` with whichever credential is here, without asking the runtime key anything first or after:
 * `created`, `present` (the id was already taken in that project, so a replica that lost a race gets it too), or
 * `skipped` when nothing here can create it. `ensureLearningContainer` wraps it with the key's checks; a person's own
 * Learning space (learning/personal-space.ts) calls it directly.
 */
export async function createLearningContainer(
  input: LearningContainerCredentials & { container?: LearningContainerSpec },
): Promise<"created" | "present" | "skipped"> {
  const run = input.run ?? runCli;
  const container = input.container ?? OPENBOT_CONTAINER;
  // The operator's fallback is to create the shared default by hand; it only applies to that container.
  const orCreateIt =
    container.id === OPENBOT_CONTAINER.id
      ? CREATE_IN_INTELLIGENCE
      : `or create a Learning container with ID "${container.id}" in that project in the backend dashboard.`;
  if (input.key.create) {
    const created = await input.key.create(container);
    if (created !== "unsupported") return created;
  }
  if (input.serviceToken) {
    return createWithServiceToken({
      apiUrl: input.apiUrl,
      serviceToken: input.serviceToken,
      fetch: input.fetch ?? fetch,
      container,
    });
  }
  if (input.apiUrl !== MANAGED_API) {
    // Self-hosted creation needs a browser sign-in, which only a person can complete.
    if (input.nonInteractive || !input.setupSelfHosted) return "skipped";
    await input.setupSelfHosted();
    return "created";
  }
  const selectedPath = resolve(input.directory, ".copilotkit/project.json");
  const text = await readFile(selectedPath, "utf8").catch(() => undefined);
  if (text === undefined && input.nonInteractive && input.cliLogin === false)
    return "skipped";
  const owner = await input.key.project();
  if (text !== undefined) {
    const selected = json(text);
    const projectId = selected.projectId;
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error(
        "The selected project is invalid. Run npx --yes copilotkit@latest project select again.",
      );
    }
    const confirmed =
      owner &&
      typeof selected.projectSlug === "string" &&
      selected.projectSlug === owner.projectSlug
        ? await (async () => {
            const listing = listedProjects(
              await run(["project", "list", "--json"], input.directory),
            );
            return listing
              ? keysProject(
                  owner,
                  await loginOrganization(run, input.directory),
                  listing,
                  projectId,
                )
              : undefined;
          })()
        : undefined;
    if (!confirmed) {
      throw new Error(
        `The CopilotKit CLI's selected project could not be confirmed as the one this runtime key belongs to, so nothing was created. Select the key's project in the CLI, ${orCreateIt}`,
      );
    }
    return (await getOrCreate(run, input.directory, projectId, container))
      ? "present"
      : "created";
  }
  // No project selected here: find the key's among the projects the login can see, and act on it
  // from a scratch directory so this checkout's selection is never made or changed.
  const scratch = await mkdtemp(join(tmpdir(), "openbot-learning-"));
  try {
    const listing = listedProjects(
      await run(["project", "list", "--json"], scratch),
    );
    if (!listing) {
      if (input.nonInteractive) return "skipped";
      throw new Error(
        `This runtime key's project has no ${container.id} Learning container, and no CopilotKit CLI login is here to create one with. Sign in with npx --yes copilotkit@latest login and run this helper again, ${orCreateIt}`,
      );
    }
    const project = owner
      ? keysProject(owner, await loginOrganization(run, scratch), listing)
      : undefined;
    if (!project) {
      throw new Error(
        `None of the projects this CopilotKit CLI login can see could be confirmed as the one this runtime key belongs to, so nothing was created. Sign in to the key's organization with npx --yes copilotkit@latest login, ${orCreateIt}`,
      );
    }
    await mkdir(join(scratch, ".copilotkit"));
    await writeFile(
      join(scratch, ".copilotkit/project.json"),
      JSON.stringify({
        projectId: project.id,
        projectSlug: project.slug,
        clerkOrgId: project.organizationId,
      }),
    );
    return (await getOrCreate(run, scratch, project.id, container))
      ? "present"
      : "created";
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Make sure the runtime key's project has `openbot`, creating it with whichever credential is here.
 * Never writes `.env` and never replaces the key: the server assigns the container once it exists
 * (learning/auto-assign.ts).
 */
export async function ensureLearningContainer(
  input: LearningContainerCredentials,
): Promise<EnsureContainerResult> {
  const found = await input.key.probe(OPENBOT_CONTAINER.id);
  if (found === "present") return "present";
  if (found === "not_entitled") {
    throw new Error(
      "This project's plan does not include Learning. Nothing was created.",
    );
  }
  if (found === "learning_off") {
    throw new Error(
      "Learning is switched off in the backend (learning.enabled in its Helm chart). Turn it on there, then run this again. Nothing was created.",
    );
  }
  if (found === "unavailable") {
    // Retryable: the server gets here only after its own probe answered, so Intelligence is starting or flapping.
    throw Object.assign(
      new Error(
        "The backend could not be asked about the openbot Learning container with the configured runtime key. Check INTELLIGENCE_API_URL and INTELLIGENCE_API_KEY, then run this helper again.",
      ),
      { retryable: true },
    );
  }
  const created = await createLearningContainer(input);
  if (created === "skipped") return "skipped";
  const reused = created === "present";
  // The check that matters, whatever the project match said: can the key see it now?
  if ((await input.key.probe(OPENBOT_CONTAINER.id)) !== "present") {
    throw new Error(
      reused
        ? "The openbot container exists in the project that was used, but this runtime key cannot see it, so the key belongs to another project. Nothing was assigned."
        : "Created an openbot container, but this runtime key still cannot see it, so it is in another project. Nothing was assigned; remove that container in the backend dashboard if it is not wanted.",
    );
  }
  return created;
}

/**
 * The Helm chart's setup Job: `bun server/src/learning/ensure-container.ts` with the chart's
 * Intelligence settings and the operator's credential in the environment. One line out, and a failure
 * exits non-zero so it stays readable in the Job's logs.
 */
async function jobMain() {
  const environment = process.env;
  // The runtime key goes wherever the server sends it (a Service in the cluster, over HTTP, with the
  // bundled Intelligence). A service token or a CLI login only over HTTPS, or HTTP on loopback.
  const keyUrl = (environment.INTELLIGENCE_API_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!/^https?:\/\//.test(keyUrl))
    throw new Error("INTELLIGENCE_API_URL must be an http(s) URL.");
  const origin = (() => {
    try {
      return intelligenceApiOrigin(keyUrl);
    } catch {
      return undefined;
    }
  })();
  const apiUrl = origin ?? keyUrl;
  const apiKey = intelligenceApiKey(environment);
  if (!apiKey)
    throw new Error(
      "CPK_INTELLIGENCE_API_KEY (or INTELLIGENCE_API_KEY) is required.",
    );
  const token = environment.INTELLIGENCE_SERVICE_TOKEN?.trim();
  const projectId = environment.INTELLIGENCE_PROJECT_ID?.trim();
  if (Boolean(token) !== Boolean(projectId))
    throw new Error(
      "INTELLIGENCE_SERVICE_TOKEN and INTELLIGENCE_PROJECT_ID go together.",
    );
  const result = await ensureLearningContainer({
    directory: process.cwd(),
    apiUrl,
    nonInteractive: true,
    key: keyIntelligence(
      keyUrl,
      apiKey,
      environment.INTELLIGENCE_GATEWAY_WS_URL?.trim() || undefined,
    ),
    ...(token && projectId && origin
      ? { serviceToken: { token, projectId } }
      : {}),
    ...(origin ? {} : { cliLogin: false }),
  });
  console.log(
    result === "skipped"
      ? `Automatic Learning: no credential here could create the openbot container. ${learningSetupInstructions(apiUrl)}`
      : `Automatic Learning: the openbot container is ${result === "created" ? "created" : "present"}; OpenBot assigns it as the default unless Admin → Automatic Learning has a saved setting.`,
  );
}

if (import.meta.main) {
  jobMain().catch((error: unknown) => {
    console.log(
      `Automatic Learning: ${error instanceof Error ? error.message : "setup failed; nothing was assigned."}`,
    );
    process.exitCode = 1;
  });
}

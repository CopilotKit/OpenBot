import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

export type SetupProject = { id: string; name: string };
export type LearningConnection = {
  apiKey: string;
  apiUrl: string;
  learningContainerId: "openbot";
};
type ApiResponse = { status: number; body: unknown };
export type SetupBrowser = {
  navigate: (url: string) => Promise<void>;
  request: (
    url: string,
    options: {
      method: "GET" | "POST";
      headers: Record<string, string>;
      data?: Record<string, string>;
      maxRedirects: 0;
      signal: AbortSignal;
    },
  ) => Promise<ApiResponse>;
  close: () => Promise<void>;
};

class SetupError extends Error {}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function intelligenceApiOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SetupError(
      "Enter the Intelligence API origin as a complete URL.",
    );
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
    throw new SetupError(
      "Use an HTTPS Intelligence API origin, or HTTP on localhost for local development. Paths and embedded credentials are not supported.",
    );
  }
  return url.origin;
}

async function openBrowser(signal: AbortSignal): Promise<SetupBrowser> {
  signal.throwIfAborted();
  const missingBrowser = (error: unknown) =>
    error instanceof Error &&
    /(?:executable.*doesn't exist|distribution.*not found)/i.test(
      error.message,
    );
  const launch = (channel: "chrome" | "msedge") =>
    chromium.launch({ channel, headless: false, timeout: 30_000 });
  const browser = await launch("chrome").catch(async (error: unknown) => {
    if (missingBrowser(error)) {
      return launch("msedge").catch((edgeError: unknown) => {
        if (missingBrowser(edgeError)) {
          throw new SetupError(
            "Self-hosted Intelligence sign-in requires Google Chrome or Microsoft Edge. Install either browser, then start setup again.",
          );
        }
        throw edgeError;
      });
    }
    throw error;
  });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext();
    const page = await context.newPage();
    return {
      navigate: async (url) => {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      },
      request: async (url, options) => {
        const response = await context.request.fetch(url, {
          ...options,
          timeout: 15_000,
          maxRetries: 0,
        });
        try {
          return {
            status: response.status(),
            body: await response.json().catch(() => null),
          };
        } finally {
          await response.dispose();
        }
      },
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

function verifiedContainer(body: unknown, projectId: string): boolean {
  return (
    object(body) &&
    object(body.container) &&
    body.container.id === "openbot" &&
    String(body.container.projectId) === projectId
  );
}

/** Cookies stay in this temporary browser. Only the newly minted project key leaves it. */
export async function setupSelfHostedLearning(options: {
  apiUrl: string;
  selectProject: (
    projects: SetupProject[],
    signal: AbortSignal,
  ) => Promise<string>;
  signal?: AbortSignal;
  openBrowser?: (signal: AbortSignal) => Promise<SetupBrowser>;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<LearningConnection> {
  const apiUrl = intelligenceApiOrigin(options.apiUrl);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? 600_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal;
  let session: SetupBrowser | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= session?.close().catch(() => {
      throw new SetupError(
        "The temporary sign-in browser could not be closed. Close that window before starting setup again.",
      );
    });
    return closing;
  };
  // The finalizer awaits cleanup; this handler also interrupts browser navigation.
  const cancel = () => {
    void close()?.catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    session = await (options.openBrowser ?? openBrowser)(signal);
    signal.throwIfAborted();
    const browser = session;
    const request = async (
      path: string,
      method: "GET" | "POST" = "GET",
      data?: Record<string, string>,
    ) => {
      signal.throwIfAborted();
      return browser.request(`${apiUrl}${path}`, {
        method,
        headers: { Origin: apiUrl, Accept: "application/json" },
        ...(data ? { data } : {}),
        maxRedirects: 0,
        signal,
      });
    };
    const signIn = new URL("/auth/signin", apiUrl);
    signIn.searchParams.set("callbackUrl", `${apiUrl}/`);
    await session.navigate(signIn.toString());
    while (true) {
      const me = await request("/api/me");
      if (me.status === 200 && object(me.body) && object(me.body.principal)) {
        break;
      }
      if (![200, 401, 403].includes(me.status)) {
        throw new SetupError(
          "Intelligence sign-in could not be verified. Check the API URL and deployment availability.",
        );
      }
      await delay(options.pollIntervalMs ?? 750, undefined, { signal });
    }
    const organizations = await request("/api/me/accessible-orgs");
    if (
      organizations.status !== 200 ||
      !object(organizations.body) ||
      !Array.isArray(organizations.body.organizations)
    ) {
      throw new SetupError("Intelligence could not list your organizations.");
    }
    const projects = new Map<string, SetupProject>();
    for (const org of organizations.body.organizations) {
      if (!object(org) || typeof org.id !== "string" || !org.id) {
        throw new SetupError("Intelligence returned an invalid organization.");
      }
      const result = await request(
        `/api/organizations/${encodeURIComponent(org.id)}/projects`,
      );
      if (
        result.status !== 200 ||
        !object(result.body) ||
        !Array.isArray(result.body.projects)
      ) {
        throw new SetupError("Intelligence could not list your projects.");
      }
      for (const project of result.body.projects) {
        if (
          !object(project) ||
          typeof project.id !== "number" ||
          !Number.isSafeInteger(project.id) ||
          project.id <= 0 ||
          typeof project.name !== "string"
        ) {
          throw new SetupError("Intelligence returned an invalid project.");
        }
        const id = String(project.id);
        projects.set(id, { id, name: project.name });
      }
    }
    if (projects.size === 0) {
      throw new SetupError(
        "No accessible Intelligence projects were found. Ask your Intelligence administrator for project access.",
      );
    }
    const projectId = await options.selectProject(
      [...projects.values()],
      signal,
    );
    signal.throwIfAborted();
    if (!projects.has(projectId)) {
      throw new SetupError(
        "Select one of the accessible Intelligence projects.",
      );
    }
    // Learning and key endpoints each authorize this project. Older Intelligence
    // releases support these routes without a separate project HEAD endpoint.
    const containers = `/api/learning/projects/${projectId}/containers`;
    let container = await request(`${containers}/openbot`);
    if (
      container.status === 200 &&
      object(container.body) &&
      container.body.container === null
    ) {
      container = await request(containers, "POST", {
        id: "openbot",
        name: "OpenBot",
      });
      if (
        container.status === 409 &&
        object(container.body) &&
        object(container.body.error) &&
        container.body.error.code === "LEARNING_CONTAINER_ALREADY_EXISTS"
      ) {
        container = await request(`${containers}/openbot`);
      }
    }
    if (
      ![200, 201].includes(container.status) ||
      !verifiedContainer(container.body, projectId)
    ) {
      throw new SetupError(
        "The openbot container could not be verified in the selected project. Check Learning access in Intelligence.",
      );
    }
    const key = await request(`/api/projects/${projectId}/api-keys`, "POST", {
      name: "OpenBot",
    });
    if (
      key.status !== 201 ||
      !object(key.body) ||
      !object(key.body.key) ||
      typeof key.body.key.token !== "string" ||
      !key.body.key.token.startsWith("cpk-")
    ) {
      throw new SetupError(
        "Intelligence could not provision the project runtime key.",
      );
    }
    signal.throwIfAborted();
    return {
      apiKey: key.body.key.token,
      apiUrl,
      learningContainerId: "openbot",
    };
  } catch (error) {
    if (signal.aborted) {
      throw new SetupError(
        timeout.signal.aborted
          ? "Intelligence setup timed out."
          : "Intelligence setup cancelled.",
      );
    }
    if (error instanceof SetupError) throw error;
    // Browser and HTTP exceptions can include cookies, response bodies, or URLs.
    throw new SetupError(
      "Intelligence browser setup failed. Install Chrome or Edge, check the API URL and browser policy, then try again.",
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    await close();
  }
}

async function desktopMain() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { desktop: { type: "boolean" }, "api-url": { type: "string" } },
    strict: true,
  });
  if (!values.desktop || !values["api-url"]) {
    throw new SetupError("Desktop setup requires --desktop and --api-url.");
  }
  const controller = new AbortController();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let receive: ((projectId: string) => void) | undefined;
  let finished = false;
  const cancel = () => controller.abort();
  input.on("line", (line) => {
    try {
      const value: unknown = JSON.parse(line);
      if (object(value) && value.type === "cancel") cancel();
      else if (
        object(value) &&
        typeof value.projectId === "string" &&
        receive
      ) {
        receive(value.projectId);
        receive = undefined;
      } else cancel();
    } catch {
      cancel();
    }
  });
  input.on("close", () => {
    if (!finished) cancel();
  });
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const connection = await setupSelfHostedLearning({
      apiUrl: values["api-url"],
      signal: controller.signal,
      selectProject: (projects, signal) =>
        new Promise((resolve, reject) => {
          const aborted = () =>
            reject(new SetupError("Intelligence setup cancelled."));
          signal.addEventListener("abort", aborted, { once: true });
          receive = (id) => {
            signal.removeEventListener("abort", aborted);
            resolve(id);
          };
          console.log(JSON.stringify({ type: "projects", projects }));
        }),
    });
    finished = true;
    console.log(JSON.stringify({ type: "connection", ...connection }));
  } finally {
    finished = true;
    input.close();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (import.meta.main) {
  desktopMain().catch((error: unknown) => {
    console.log(
      JSON.stringify({
        type: "error",
        message:
          error instanceof SetupError
            ? error.message
            : "Intelligence setup failed.",
      }),
    );
    process.exitCode = 1;
  });
}

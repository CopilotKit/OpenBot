/**
 * Finds the AI already running on this computer, the way Cindy's "Detected on this computer" does
 * (github.com/makecindy/cindy, Apache-2.0; the idea, written fresh here): Ollama on 11434 and LM
 * Studio on 1234, both of which speak the OpenAI API under `/v1`.
 *
 * Only these fixed local addresses are ever asked, never one a caller supplies, so this cannot be
 * pointed anywhere else. Inside Docker, the computer itself is `host.docker.internal`.
 */

export type LocalModel = { id: string; sizeBytes: number | null };

export type LocalRuntime = {
  name: "Ollama" | "LM Studio";
  /** The OpenAI-compatible address, with `/v1`, as `OPENAI_BASE_URL` takes it. */
  baseUrl: string;
  models: LocalModel[];
};

export type LocalAiReport = {
  runtimes: LocalRuntime[];
  /** What this server is pointed at now, from its own settings. */
  inUse: { baseUrl: string | null; model: string | null; isLocal: boolean };
};

type Fetcher = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<Response>;

const HOSTS = ["127.0.0.1", "host.docker.internal"] as const;
const TIMEOUT_MS = 1500;

async function getJson(fetcher: Fetcher, url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function ollamaModels(body: unknown): LocalModel[] | null {
  const models = (body as { models?: unknown })?.models;
  if (!Array.isArray(models)) return null;
  return models
    .map((entry): LocalModel | null => {
      const name = (entry as { name?: unknown }).name;
      const size = (entry as { size?: unknown }).size;
      return typeof name === "string"
        ? { id: name, sizeBytes: typeof size === "number" ? size : null }
        : null;
    })
    .filter((entry): entry is LocalModel => entry !== null);
}

function openAiModels(body: unknown): LocalModel[] | null {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return null;
  return (
    data
      .map((entry): LocalModel | null => {
        const id = (entry as { id?: unknown }).id;
        return typeof id === "string" ? { id, sizeBytes: null } : null;
      })
      .filter((entry): entry is LocalModel => entry !== null)
      // LM Studio lists its embedding models too; those cannot chat.
      .filter((entry) => !/embed/i.test(entry.id))
  );
}

/** The first host that answers for one runtime, or nothing. */
async function find(
  fetcher: Fetcher,
  name: LocalRuntime["name"],
  port: number,
  path: string,
  parse: (body: unknown) => LocalModel[] | null,
): Promise<LocalRuntime | null> {
  for (const host of HOSTS) {
    const models = parse(
      await getJson(fetcher, `http://${host}:${port}${path}`),
    );
    if (models) return { name, baseUrl: `http://${host}:${port}/v1`, models };
  }
  return null;
}

export function isLocalBaseUrl(value: string | undefined | null): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).hostname;
    return ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(
      host,
    );
  } catch {
    return false;
  }
}

export async function detectLocalAi(
  environment: Record<string, string | undefined>,
  fetcher: Fetcher = fetch,
): Promise<LocalAiReport> {
  const found = await Promise.all([
    find(fetcher, "Ollama", 11434, "/api/tags", ollamaModels),
    find(fetcher, "LM Studio", 1234, "/v1/models", openAiModels),
  ]);
  const baseUrl = environment.OPENAI_BASE_URL?.trim() || null;
  return {
    runtimes: found.filter(
      (runtime): runtime is LocalRuntime => runtime !== null,
    ),
    inUse: {
      baseUrl,
      model: environment.BOT_MODEL?.trim() || null,
      isLocal: isLocalBaseUrl(baseUrl),
    },
  };
}

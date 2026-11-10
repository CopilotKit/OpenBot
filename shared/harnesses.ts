import catalogue from "./harnesses.json";

/**
 * The agent harnesses OpenBot knows by name, read from the one file every language reads.
 *
 * WHY A SHARED FILE. The list began in `desktop/src-tauri/src/harness.rs`, where it decides which
 * image the setup window runs. The web app's New Bot dialog needs the same names, summaries and
 * marks to say "the thing you already run is one of these" — and a second copy would drift, which
 * matters more here than for most lists because this one carries other companies' trade marks and
 * the rules in `shared/marks/README.md` about what may be drawn for them.
 *
 * The desktop reads this file through Rust rather than through this module: it is not in the root
 * bun workspace, so `include_str!` takes the JSON directly. That is why the data lives in `.json`
 * and only the typing lives here.
 */
/**
 * What a harness needs before it can answer.
 *
 * `google` is its own variant rather than `any-provider` because Antigravity's harness requires a
 * Gemini key wherever its base url points — "any provider the person already has" is exactly the
 * promise it cannot keep, and a deployment holding only an OpenAI key would install a Bot that
 * never answers.
 */
export type Credential =
  | "any-provider"
  | "anthropic"
  | "google"
  | "their-endpoint";
export type Maintainer = "first-party" | "partnership" | "community";

export type Harness = {
  id: string;
  name: string;
  /** The installer's sentence. Written for a window that runs the image for you. */
  summary: string;
  /**
   * What the web dialog says instead, where the installer's sentence is false on a surface that
   * installs nothing. Null means `summary` is true everywhere and is used as-is.
   */
  webSummary: string | null;
  /** The directory a release builds `openbot-<directory>` from, not the id. Null when none. */
  image: string | null;
  port: number | null;
  healthPath: string | null;
  runPath: string;
  credential: Credential;
  maintainer: Maintainer;
  /** The file stem under `shared/marks/`, or null where no maintained set has one. */
  mark: string | null;
  /**
   * Whether the web create API can actually make this row work.
   *
   * False for Mastra alone: the server reaches it as `remote_mastra` through the `@ag-ui/mastra`
   * bridge and needs a roster id to say which agent it means, and the create endpoint can send
   * neither. Offered in the dialog it would make a Bot that appears, accepts a grant, and answers
   * nothing.
   */
  webCreate: boolean;
};

/*
 * Asserted rather than inferred: a JSON import widens `credential` and `maintainer` to `string`,
 * and the point of naming them as unions is that a typo in the file is caught. `harnesses.test.ts`
 * is what actually checks the data, including that every mark it names is vendored.
 */
export const HARNESSES: readonly Harness[] =
  catalogue.harnesses as readonly Harness[];

/**
 * The partners a person adding a Bot looks for first, in the order the web lists them.
 *
 * The catalogue is ranked stars-first, which suits the desktop installer choosing an image to run
 * but not somebody scanning for their own framework: Atai, October 19, read CrewAI, LlamaIndex and
 * Agno at the top as "the ones on top don't make sense", and reported LangChain and ADK missing when
 * they were fourth and fifth. These lead; everything else follows in the catalogue's own order.
 */
const WEB_LEAD: readonly string[] = [
  "claude-agent-sdk",
  "google-adk",
  "antigravity",
  "langgraph",
];

/** Where a harness sits in the web list: its lead position, or after every lead. */
function webRank(harness: Harness): number {
  const lead = WEB_LEAD.indexOf(harness.id);
  return lead === -1 ? WEB_LEAD.length : lead;
}

/**
 * What the web dialog may offer: the leads first, then the catalogue's order, which keeps "An agent
 * you already run" last. The sort is stable, so the rows after the leads keep their ranking.
 */
export const WEB_HARNESSES: readonly Harness[] = HARNESSES.filter(
  (harness) => harness.webCreate,
).sort((a, b) => webRank(a) - webRank(b));

/** The sentence to draw on a web surface: the override where there is one, else the installer's. */
export function summaryFor(harness: Harness): string {
  return harness.webSummary ?? harness.summary;
}

/**
 * Names the catalogue gave a framework before its current one, by harness id.
 *
 * A Bot an earlier version seeded under one of these is still named after its framework: the
 * installer moves it like one under the current name, and its subtitle reads the current name.
 */
export const EARLIER_HARNESS_NAMES: Readonly<
  Record<string, readonly string[]>
> = {
  langgraph: ["LangGraph", "LangChain (LangGraph)"],
};

/**
 * The Personal Assistant's subtitle as a person reads it, when it runs on a framework the installer
 * picked: what it is, what runs it, and that any other agent can be brought along, with the article
 * the name reads with ("an AWS Strands agent"). Atai's wording and punctuation, November 10. Shown
 * only: the starter is still stored, and told to the Bot, as "Everyday life. Powered by <name>.".
 */
export function starterSubtitle(name: string): string {
  const article = /^[AEIOU]/.test(name) ? "an" : "a";
  return `Everyday life agent. (powered by ${article} ${name} agent; you can bring your own agent from any stack.)`;
}

/** Every name a harness the installer can run has had, with the harness it belongs to now. */
function namesWithHarness(): Array<[string, Harness]> {
  return HARNESSES.filter(({ image }) => image !== null).flatMap((harness) =>
    [harness.name, ...(EARLIER_HARNESS_NAMES[harness.id] ?? [])].map(
      (name): [string, Harness] => [name, harness],
    ),
  );
}

/**
 * A subtitle OpenBot wrote, as a person reads it now. For the profile a person sees, never for what
 * a Bot is told.
 *
 * - The Personal Assistant's seed, "Everyday life. Powered by <framework>.", exactly as seeded under
 *   any of the framework's names, reads as {@link starterSubtitle} for its current name.
 * - Any other "Powered by <earlier name>" reads with the framework's current name.
 *
 * Only what OpenBot wrote changes. A subtitle the person rewrote no longer matches the seed, and the
 * person's own words around a "Powered by" stay as they wrote them.
 */
export function withCurrentFrameworkNames(title: string): string {
  for (const [name, harness] of namesWithHarness()) {
    if (title === `Everyday life. Powered by ${name}.`) {
      return starterSubtitle(harness.name);
    }
  }
  let current = title;
  for (const harness of HARNESSES) {
    for (const earlier of EARLIER_HARNESS_NAMES[harness.id] ?? []) {
      const escaped = earlier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      current = current.replace(
        new RegExp(`Powered by ${escaped}(?![\\w(])`, "g"),
        `Powered by ${harness.name}`,
      );
    }
  }
  return current;
}

/**
 * What a Bot that runs inside OpenBot is powered by: its subtitle's "Powered by OpenBot", and the
 * framework it is told it runs on.
 */
export const OPENBOT_HARNESS_NAME = "OpenBot";

/**
 * A framework a person may declare for an agent they run themselves, by id: any named harness, never
 * "An agent you already run", which names none.
 */
export function declaredHarness(id: unknown): Harness | undefined {
  if (typeof id !== "string" || id === "byo-url") return undefined;
  return HARNESSES.find((harness) => harness.id === id);
}

/**
 * The harness an image reference runs, by the directory a release builds it from:
 * `ghcr.io/copilotkit/openbot-agent-langgraph-agui@sha256:…` is LangChain. Undefined for
 * an image OpenBot does not publish.
 */
export function harnessForImage(reference: string): Harness | undefined {
  const name = /(?:^|\/)(?:openbot-)?(agent-[a-z0-9-]+)(?::|@|$)/.exec(
    reference.trim(),
  )?.[1];
  if (!name) return undefined;
  return HARNESSES.find((harness) => harness.image === name);
}

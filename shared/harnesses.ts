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

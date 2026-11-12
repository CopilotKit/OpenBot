import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  test as base,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";
import {
  AIMOCK_URL,
  dotenvValue,
  FIXTURES,
  LOGS,
  MCP_SERVER_PATH,
  RECORDING,
  RECORDING_DIR,
  SCREENSHOTS,
} from "./config";

/**
 * The `test` every journey imports. On top of Playwright's own, it adds:
 *
 * - `aimock`, automatic: every model request the test caused is read back from aimock's journal
 *   when it ends, and in replay ANY request no fixture answered fails the test, naming it. This is
 *   what makes replay strict in practice: a changed prompt, a new model call or a missing fixture
 *   is a red test with the request in front of you, never a quiet pass.
 *   In record mode it moves the recordings the test made into `e2e/fixtures/<journey>/`.
 * - `shot(name)`: a full-page screenshot into `e2e/.artifacts/screenshots/<journey>/`, numbered in
 *   the order taken, and attached to the report. A person reads every one; see the README.
 */

type JournalEntry = {
  method: string;
  path: string;
  body?: {
    model?: string;
    // Chat Completions and Messages carry `messages`; the Responses API carries `input`.
    messages?: { role: string; content: unknown }[];
    input?: string | { role?: string; content?: unknown }[];
    /** Set by aimock on a body over its 64 KB journal cap, which keeps only this note. */
    __aimock_truncated?: boolean;
  } | null;
  response: { status: number; fixture: unknown | null; source?: string };
};

/** The journey's name: its file, without `.journey.ts`. Fixtures and screenshots are keyed on it. */
export function journeyOf(testInfo: TestInfo): string {
  return basename(testInfo.file).replace(/\.journey\.ts$/, "");
}

function lastUserText(entry: JournalEntry): string {
  if (entry.body?.__aimock_truncated)
    return "(body over aimock's 64 KB journal cap)";
  const input = entry.body?.input;
  if (typeof input === "string") return input.slice(0, 160);
  const messages = entry.body?.messages ?? input ?? [];
  const user = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const content = user?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (part as { text?: string }).text ?? "")
            .join(" ")
        : "";
  return text.replace(/\s+/g, " ").slice(0, 160);
}

async function journal(): Promise<JournalEntry[]> {
  const response = await fetch(`${AIMOCK_URL}/__aimock/journal`);
  expect(response.ok, "aimock's journal answers").toBe(true);
  const body = (await response.json()) as
    | JournalEntry[]
    | { entries: JournalEntry[] };
  return Array.isArray(body) ? body : body.entries;
}

/** Recordings are whole provider exchanges. Refuse any that still holds a real key. */
function assertNoSecrets(file: string): void {
  const text = readFileSync(file, "utf8");
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    const secret = dotenvValue(name);
    if (secret && text.includes(secret)) {
      rmSync(file);
      throw new Error(
        `A recording held ${name}'s value and was deleted: ${basename(file)}`,
      );
    }
  }
}

function keepRecordings(journey: string): string[] {
  if (!existsSync(RECORDING_DIR)) return [];
  const target = join(FIXTURES, journey);
  mkdirSync(target, { recursive: true });
  const kept: string[] = [];
  for (const name of readdirSync(RECORDING_DIR).filter((file) =>
    file.endsWith(".json"),
  )) {
    const from = join(RECORDING_DIR, name);
    assertNoSecrets(from);
    renameSync(from, join(target, name));
    kept.push(name);
  }
  return kept;
}

/** The journeys whose fixtures this run has already cleared to re-record (one worker, one run). */
const rerecorded = new Set<string>();
/** How many screenshots each journey has taken this run. */
const shotsTaken = new Map<string, number>();

export const test = base.extend<{
  aimock: { requests: () => Promise<JournalEntry[]> };
  shot: (name: string) => Promise<void>;
}>({
  aimock: [
    // Playwright reads a fixture's dependencies from this destructuring, so it stays, empty.
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern here.
    async ({}, use, testInfo) => {
      const journey = journeyOf(testInfo);
      if (RECORDING && !rerecorded.has(journey)) {
        // A re-recording replaces the journey's fixtures rather than adding to them. Once per run,
        // on its first test: a journey with several tests keeps what each of them recorded.
        rmSync(join(FIXTURES, journey), { recursive: true, force: true });
        rerecorded.add(journey);
      }
      await fetch(`${AIMOCK_URL}/__aimock/reset/journal`, { method: "POST" });
      await use({ requests: journal });

      // Model requests only: aimock's own routes are internal, and the MCP server it serves for the
      // Connections journey (`MCP_SERVER_PATH`) is a server OpenBot calls, not a model.
      const entries = (await journal()).filter(
        (entry) =>
          entry.response.source !== "internal" &&
          !entry.path.startsWith(MCP_SERVER_PATH),
      );
      const lines = entries.map(
        (entry) =>
          `${entry.response.fixture ? "matched " : RECORDING ? "recorded" : "MISSED  "} ${entry.response.status} ${entry.method} ${entry.path} model=${entry.body?.model ?? "-"} user="${lastUserText(entry)}"`,
      );
      // Also kept beside aimock's log, one line per model request: what was asked, what answered.
      // And the requests themselves, without their headers, for when a line is not enough.
      writeFileSync(
        join(LOGS, `${journey}.model-requests.txt`),
        `${lines.join("\n")}\n`,
      );
      writeFileSync(
        join(LOGS, `${journey}.model-requests.json`),
        JSON.stringify(
          entries.map(({ method, path, body, response }) => ({
            method,
            path,
            body,
            response: { status: response.status, matched: !!response.fixture },
          })),
          null,
          2,
        ),
      );
      await testInfo.attach("aimock requests", {
        body: lines.join("\n") || "(no model requests)",
        contentType: "text/plain",
      });
      if (RECORDING) {
        const kept = keepRecordings(journey);
        await testInfo.attach("recorded fixtures", {
          body: kept.join("\n") || "(none)",
          contentType: "text/plain",
        });
        return;
      }
      const missed = lines.filter((line) => line.startsWith("MISSED"));
      expect(
        missed,
        `Every model request this journey made must be answered by a fixture (strict replay). Re-record with bun run test:e2e:record if the change is intended.\n${missed.join("\n")}`,
      ).toEqual([]);
    },
    { auto: true },
  ],

  shot: async ({ page }, use, testInfo) => {
    const journey = journeyOf(testInfo);
    const folder = join(SCREENSHOTS, journey);
    // Cleared once per run, and numbered on across a journey's tests, so a journey with several
    // tests keeps every test's screenshots rather than only its last test's.
    if (!shotsTaken.has(journey)) {
      rmSync(folder, { recursive: true, force: true });
      shotsTaken.set(journey, 0);
    }
    mkdirSync(folder, { recursive: true });
    await use(async (name: string) => {
      const taken = (shotsTaken.get(journey) ?? 0) + 1;
      shotsTaken.set(journey, taken);
      const path = join(
        folder,
        `${String(taken).padStart(2, "0")}-${name}.png`,
      );
      // Animations finished first: a dialog or list caught mid-fade reads as a broken layout.
      await page.screenshot({ path, fullPage: true, animations: "disabled" });
      await testInfo.attach(name, { path, contentType: "image/png" });
    });
  },
});

export { expect, type Page };

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The reset handler, driven over HTTP against the real process.
 *
 * `sessions.test.ts` covers when a run changes, and it cannot cover whether the handler asks. That
 * gap is the whole of the reset half: a reset that wipes the profile and leaves the run alone reads
 * as correct in every unit test and still lets a save that was in flight bring the wiped page back.
 *
 * So this one imports `index.ts` and talks to the port it opens. It never launches a browser, which
 * is what usually makes that impossible here: `/run` reads the session and `/computers/reset` stops a
 * browser that was never started and deletes a directory under a temporary root, so Chromium is
 * never asked for a page. The profiles root and the workspace are pointed somewhere disposable
 * before the import, because the module reads both at load.
 */

const TOKEN = "test-computer-token";
const PORT = 41537;
const BASE = `http://127.0.0.1:${PORT}`;

let root = "";

async function run(botId: string): Promise<string | undefined> {
  const response = await fetch(`${BASE}/run`, {
    headers: {
      "x-openbot-bot-id": botId,
      "x-openbot-computer-token": TOKEN,
    },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { run?: string }).run;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-computer-reset-"));
  process.env.COMPUTER_TOKEN = TOKEN;
  process.env.PORT = String(PORT);
  process.env.PROFILES_DIR = join(root, "profiles");
  process.env.WORKSPACE_DIR = join(root, "workspace");
  // Imported after the environment is set, because the module reads it while it loads.
  await import("../src/index");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the run this computer reports", () => {
  test("is there before anything has started a browser", async () => {
    expect(await run("bot-1")).toBeTruthy();
  });

  test("is the same one on the next request", async () => {
    // The control. A run minted per request would change every time and refuse every ref the server
    // holds, which looks identical to a working fix from the server's side of one call.
    const first = await run("bot-2");
    expect(await run("bot-2")).toBe(first as string);
  });

  test("is not shared with another Bot", async () => {
    expect(await run("bot-3")).not.toBe(await run("bot-4"));
  });

  test("changes when the computer is reset", async () => {
    const before = await run("bot-5");

    const reset = await fetch(`${BASE}/computers/reset`, {
      method: "POST",
      headers: {
        "x-openbot-bot-id": "bot-5",
        "x-openbot-computer-token": TOKEN,
      },
    });
    expect(reset.status).toBe(200);

    expect(await run("bot-5")).not.toBe(before as string);
  });

  test("resetting one Bot leaves another Bot's alone", async () => {
    const other = await run("bot-6");
    await fetch(`${BASE}/computers/reset`, {
      method: "POST",
      headers: {
        "x-openbot-bot-id": "bot-7",
        "x-openbot-computer-token": TOKEN,
      },
    });
    expect(await run("bot-6")).toBe(other as string);
  });

  test("is not told to a caller with no token", async () => {
    // It names a Bot and describes this process's state, so it belongs behind the same secret as
    // everything else here. Only `/health` is open.
    const response = await fetch(`${BASE}/run`, {
      headers: { "x-openbot-bot-id": "bot-1" },
    });
    expect(response.status).toBe(401);
  });

  test("is not told to a caller with the wrong token", async () => {
    const response = await fetch(`${BASE}/run`, {
      headers: {
        "x-openbot-bot-id": "bot-1",
        "x-openbot-computer-token": "not-the-token",
      },
    });
    expect(response.status).toBe(401);
  });

  test("is still answered while a person holds the wheel", async () => {
    /*
     * The refusal that guards acting must not reach a read. The server asks this on the path of every
     * governed action, including the ones it is about to refuse, so a 409 here would turn every ref
     * it holds into an unanswerable question for as long as somebody was driving.
     */
    const taken = await fetch(`${BASE}/control/take`, {
      method: "POST",
      headers: {
        "x-openbot-bot-id": "bot-8",
        "x-openbot-computer-token": TOKEN,
      },
    });
    expect(taken.status).toBe(200);

    expect(await run("bot-8")).toBeTruthy();
  });
});

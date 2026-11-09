import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reservePort } from "../../tests/support/reserved-port";

/**
 * Actions a model sends together, on one browser: the real process, its dispatcher and bundled Chromium headless.
 *
 * A model that calls tools in parallel sends a whole form's worth of `computer_type` in one step, and they reach the
 * computer together. Each one focuses its own field before it types, so run side by side they took the focus from
 * each other and the form kept some of the values and lost the rest. One browser takes one action at a time, in the
 * order they arrived, whatever the model sends.
 *
 * And the Bot reads the form back to check its work: a field that shows a placeholder read as empty however often it
 * was filled, so the Bot typed it again and again.
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/parallel-actions-computer.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const TOKEN = "parallel-actions-computer-token";
const BOT = "parallel-bot";
/** Short, so the test of an action that never finishes does not wait the default ten seconds. */
const ACTION_TIMEOUT_MS = 2_000;

let root = "";
let base = "";
let origin = "";
let child: ReturnType<typeof Bun.spawn> | undefined;
let site: ReturnType<typeof Bun.serve> | undefined;

/*
 * A CRM's new-account form, as Kite CRM draws it: some fields show a placeholder until they are filled, and a Bot
 * reads every field back from a snapshot to check its work.
 */
const PLACEHOLDERS: Record<string, string> = {
  Website: "company.com",
  Headquarters: "City, State",
  Employees: "e.g. 1,200",
  Notes: "What you know about this company",
};
const FIELDS = [
  "Account name",
  "Website",
  "Headquarters",
  "Employees",
  "Source",
  "Notes",
];
const FORM = `<title>New account</title><h1>New account</h1>
  <form>${FIELDS.map(
    (name, index) =>
      `<label>${name} <input id="f${index}" name="${name}" aria-label="${name}"${
        PLACEHOLDERS[name] ? ` placeholder="${PLACEHOLDERS[name]}"` : ""
      }></label>`,
  ).join("")}
  <button type="button" id="covered">Save</button>
  <div style="position:fixed;inset:0;background:transparent"></div>
  </form>`;

async function call<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      "x-openbot-bot-id": BOT,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  return { status: response.status, json: (await response.json()) as T };
}

type Snapshot = {
  snapshotId: number;
  elements: Array<{ ref: string; role: string; name: string; value?: string }>;
};

async function openForm(): Promise<Snapshot> {
  expect((await call("/navigate", { url: `${origin}/new` })).status).toBe(200);
  const { status, json } = await call<Snapshot>("/snapshot", {});
  expect(status).toBe(200);
  return json;
}

function refOf(snap: Snapshot, name: string): string {
  const element = snap.elements.find((each) => each.name === name);
  if (!element) throw new Error(`No ${name} on the form.`);
  return element.ref;
}

async function values(): Promise<Record<string, string | undefined>> {
  const { json } = await call<Snapshot>("/snapshot", {});
  return Object.fromEntries(
    FIELDS.map((name) => [
      name,
      json.elements.find((each) => each.name === name)?.value,
    ]),
  );
}

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "parallel-actions-"));
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/new"
        ? new Response(FORM, { headers: { "content-type": "text/html" } })
        : new Response("Not found", { status: 404 }),
  });
  origin = `http://127.0.0.1:${site.port}`;
  const port = await reservePort();
  base = `http://127.0.0.1:${port}`;
  child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      ACTION_TIMEOUT_MS: String(ACTION_TIMEOUT_MS),
      // No API server pushes this computer a network policy, so it browses before one arrives.
      EGRESS_POLICY_REQUIRED: "0",
      PROFILES_DIR: join(root, "profiles"),
      WORKSPACE_DIR: join(root, "workspace"),
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`The computer exited with ${child.exitCode}.`);
    const ready = await fetch(`${base}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) break;
    if (Date.now() > deadline) throw new Error("The computer did not start.");
    await Bun.sleep(50);
  }
});

afterAll(async () => {
  if (!asked) return;
  child?.kill();
  if (child) await child.exited;
  await site?.stop(true);
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!asked)("actions sent together, on one browser", () => {
  test("a field that shows a placeholder reads back what was typed in it", async () => {
    // One at a time, so only the reading is under test. Read as empty, a Bot checking its work typed the value again.
    const snap = await openForm();
    for (const name of ["Website", "Employees"]) {
      const typed = await call("/type", {
        ref: refOf(snap, name),
        snapshotId: snap.snapshotId,
        text: name === "Website" ? "halvorsen.com" : "2,400",
      });
      expect(typed.status).toBe(200);
    }
    const read = await values();
    expect([read.Website, read.Employees, read.Headquarters]).toEqual([
      "halvorsen.com",
      "2,400",
      undefined,
    ]);
  });

  test("a form's worth of typing sent at once keeps every value in its own field", async () => {
    // Long enough that typing one value takes several frames, as a real address or a note does, and short enough
    // that a snapshot reads it back whole (it cuts a value at 200 characters).
    const wanted = Object.fromEntries(
      FIELDS.map((name, index) => [
        name,
        `${name} value ${index} `.repeat(6).trim(),
      ]),
    );
    // Several rounds, because a race that loses a value only sometimes is still the bug.
    for (let round = 0; round < 3; round += 1) {
      const snap = await openForm();
      const sent = await Promise.all(
        FIELDS.map((name) =>
          call("/type", {
            ref: refOf(snap, name),
            snapshotId: snap.snapshotId,
            text: wanted[name],
          }),
        ),
      );
      expect(sent.map((each) => each.status)).toEqual(FIELDS.map(() => 200));
      expect(await values()).toEqual(wanted);
    }
  });

  test("a snapshot sent beside typing reads the typing that was sent before it", async () => {
    const snap = await openForm();
    const [typed, read] = await Promise.all([
      call("/type", {
        ref: refOf(snap, "Notes"),
        snapshotId: snap.snapshotId,
        text: "Met at the expo. ".repeat(10),
      }),
      // Sent a moment later, as the next call in the same step is.
      Bun.sleep(5).then(() => call<{ elements: unknown[] }>("/snapshot", {})),
    ]);
    expect(typed.status).toBe(200);
    expect(read.status).toBe(200);
    expect((await values()).Notes).toBe("Met at the expo. ".repeat(10).trim());
  });

  test("an action that never finishes gives way to the ones behind it", async () => {
    const snap = await openForm();
    // The Save button sits under a transparent overlay, so a click on it waits out the whole action timeout.
    const started = Date.now();
    const [stuck, typed] = await Promise.all([
      call<{ error?: string }>("/click", {
        ref: refOf(snap, "Save"),
        snapshotId: snap.snapshotId,
      }),
      Bun.sleep(5).then(() =>
        call("/type", {
          ref: refOf(snap, "Website"),
          snapshotId: snap.snapshotId,
          text: "example.com",
        }),
      ),
    ]);
    expect(stuck.status).not.toBe(200);
    expect(typed.status).toBe(200);
    expect((await values()).Website).toBe("example.com");
    // One action timeout and the typing, not a queue held open indefinitely.
    expect(Date.now() - started).toBeLessThan(ACTION_TIMEOUT_MS * 3);
  });

  test("an action stopped while it waits its turn never runs", async () => {
    const snap = await openForm();
    const stop = new AbortController();
    const stuck = call("/click", {
      ref: refOf(snap, "Save"),
      snapshotId: snap.snapshotId,
    });
    await Bun.sleep(50);
    const waiting = call(
      "/type",
      {
        ref: refOf(snap, "Source"),
        snapshotId: snap.snapshotId,
        text: "Referral",
      },
      stop.signal,
    ).catch(() => "stopped");
    await Bun.sleep(50);
    stop.abort();
    expect(await waiting).toBe("stopped");
    expect((await stuck).status).not.toBe(200);
    expect((await values()).Source).toBeUndefined();
  });
});

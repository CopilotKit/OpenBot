import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reservePort } from "../../tests/support/reserved-port";

/**
 * A followed link, checked on the computer: the real process, its dispatcher and bundled Chromium headless.
 *
 * The server opens a link by `/navigate` with the ref and snapshot it read the link from. Only the computer knows
 * whether the page has moved on since, so it checks that citation exactly as `/click` would before opening anything:
 * a superseded snapshot, a ref that names nothing, and a link that now goes elsewhere are all refused as stale, and
 * the browser stays where it was.
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/link-follow-computer.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const TOKEN = "link-follow-computer-token";
const BOT = "link-bot";

let root = "";
let base = "";
let origin = "";
let child: ReturnType<typeof Bun.spawn> | undefined;
let site: ReturnType<typeof Bun.serve> | undefined;

const PAGES: Record<string, string> = {
  "/orders": `<title>Orders</title><h1>Orders</h1>
    <a href="/orders/PO-102">PO 102</a>
    <button onclick="document.querySelector('a').href='/elsewhere'">Repoint</button>`,
  "/orders/PO-102": "<title>PO 102</title><h1>PO 102</h1>",
  "/elsewhere": "<title>Elsewhere</title><h1>Elsewhere</h1>",
  "/other": "<title>Other</title><h1>Other</h1>",
};

async function call<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      "x-openbot-bot-id": BOT,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as T };
}

type Snapshot = {
  snapshotId: number;
  url: string;
  elements: Array<{ ref: string; role: string; name: string; url?: string }>;
};

async function snapshot(): Promise<Snapshot> {
  const { status, json } = await call<Snapshot>("/snapshot", {});
  expect(status).toBe(200);
  return json;
}

async function linkOnOrders(): Promise<{
  snap: Snapshot;
  ref: string;
  url: string;
}> {
  expect((await call("/navigate", { url: `${origin}/orders` })).status).toBe(
    200,
  );
  const snap = await snapshot();
  const link = snap.elements.find(
    (each) => each.role === "link" && each.name === "PO 102",
  );
  if (!link?.url) throw new Error("The orders page's link carried no address.");
  return { snap, ref: link.ref, url: link.url };
}

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "link-follow-"));
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const html = PAGES[new URL(request.url).pathname];
      return html
        ? new Response(html, { headers: { "content-type": "text/html" } })
        : new Response("Not found", { status: 404 });
    },
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

describe.skipIf(!asked)(
  "a followed link, checked against the live page",
  () => {
    test("from the current snapshot, it opens", async () => {
      const { snap, ref, url } = await linkOnOrders();
      const opened = await call<{ url: string }>("/navigate", {
        url,
        ref,
        snapshotId: snap.snapshotId,
      });
      expect(opened.status).toBe(200);
      expect(opened.json.url).toBe(`${origin}/orders/PO-102`);
    });

    test("after the browser has moved on, the old citation is stale and nothing opens", async () => {
      const { snap, ref, url } = await linkOnOrders();
      expect((await call("/navigate", { url: `${origin}/other` })).status).toBe(
        200,
      );

      const followed = await call<{ stale?: boolean }>("/navigate", {
        url,
        ref,
        snapshotId: snap.snapshotId,
      });
      expect(followed.status).toBe(409);
      expect(followed.json.stale).toBe(true);
      // The same answer `/click` gives for that citation.
      const clicked = await call<{ stale?: boolean }>("/click", {
        ref,
        snapshotId: snap.snapshotId,
      });
      expect(clicked.status).toBe(409);
      expect((await snapshot()).url).toBe(`${origin}/other`);
    });

    test("a link the page has since repointed is stale, not opened at its old address", async () => {
      const { ref, url } = await linkOnOrders();
      const snap = await snapshot();
      const repoint = snap.elements.find((each) => each.name === "Repoint");
      if (!repoint) throw new Error("No Repoint button.");
      expect(
        (
          await call("/click", {
            ref: repoint.ref,
            snapshotId: snap.snapshotId,
          })
        ).status,
      ).toBe(200);
      const current = await snapshot();
      const link = current.elements.find((each) => each.name === "PO 102");
      if (!link) throw new Error("The link went away.");

      const followed = await call<{ stale?: boolean }>("/navigate", {
        url,
        ref: link.ref,
        snapshotId: current.snapshotId,
      });
      expect(followed.status).toBe(409);
      expect((await snapshot()).url).toBe(`${origin}/orders`);
      expect(ref).toBeTruthy();
    });

    test("half a citation is refused", async () => {
      const { url } = await linkOnOrders();
      expect((await call("/navigate", { url, ref: "e1" })).status).toBe(400);
    });
  },
);

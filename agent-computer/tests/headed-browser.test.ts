import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reservePort } from "../../tests/support/reserved-port";

/**
 * The optional full browser, driven as the container drives it.
 *
 * Asked for explicitly because it needs a virtual display and a real Chromium:
 *
 *   OPENBOT_HEADED_BROWSER=1 bun test tests/headed-browser.test.ts
 *
 * The computer starts and owns Xvfb itself. Wrapping this command in xvfb-run would hide display
 * allocation bugs by giving Chromium a second display it does not own.
 */
const asked = process.env.OPENBOT_HEADED_BROWSER === "1";
const TOKEN = "headed-browser-test-token";
const BOT = "headed-browser";

let base = "";
let root = "";
let site: ReturnType<typeof Bun.serve> | undefined;
/** What the sign-up form below sent, as the site received it. */
const signUps: URLSearchParams[] = [];

/**
 * A sign-up form with text fields, a native dropdown, a note and a button, laid out so the
 * dropdown's list opens over the note and the button.
 */
const SIGN_UP = `<!doctype html><title>Garden Club Sign-up</title>
<style>body{font-family:sans-serif;max-width:520px;margin:40px auto}label{display:block;margin:14px 0 4px}input,select,textarea{width:100%;padding:8px;box-sizing:border-box}button{margin-top:18px;padding:10px 18px}</style>
<h1>Garden Club Sign-up</h1>
<form method="post" action="/signed-up">
<label for="full_name">Full name</label><input id="full_name" name="full_name" required>
<label for="email">Email</label><input id="email" name="email" type="email" required>
<label for="plant">Favourite plant</label>
<select id="plant" name="plant"><option value="">Choose one</option><option>Tomato</option><option>Basil</option><option>Sunflower</option><option>Fern</option></select>
<label for="note">Note</label><textarea id="note" name="note" rows="3"></textarea>
<button type="submit">Sign up</button>
</form>`;

const html = (body: string) =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

function api(path: string, init?: RequestInit) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-openbot-bot-id": BOT,
      "x-openbot-computer-token": TOKEN,
      ...(init?.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "agent-computer-headed-"));
  const port = await reservePort();
  base = `http://127.0.0.1:${port}`;
  process.env.COMPUTER_TOKEN = TOKEN;
  // Linux is where hosted computers run and headed is their default, so it is left to the default
  // there; anywhere else it has to be asked for.
  if (process.platform === "linux") delete process.env.COMPUTER_BROWSER_MODE;
  else process.env.COMPUTER_BROWSER_MODE = "headed";
  process.env.PORT = String(port);
  // No API server pushes this computer a network policy, so it browses before one arrives, as in
  // person-browser-computer.test.ts. The page is served over http because `/navigate` refuses data: URLs.
  process.env.EGRESS_POLICY_REQUIRED = "0";
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/sign-up") return html(SIGN_UP);
      if (pathname === "/signed-up" && request.method === "POST") {
        signUps.push(new URLSearchParams(await request.text()));
        return html(
          "<!doctype html><title>Signed up</title><h1>Thanks, you are signed up.</h1>",
        );
      }
      return html(
        "<!doctype html><body></body><script>document.body.textContent=navigator.userAgent+'\\nwebdriver='+navigator.webdriver</script>",
      );
    },
  });
  process.env.PROFILES_DIR = join(root, "profiles");
  process.env.WORKSPACE_DIR = join(root, "workspace");
  await mkdir(process.env.PROFILES_DIR, { recursive: true });
  await import(`../src/index?headed=${Date.now()}`);
});

afterAll(async () => {
  if (!asked) return;
  await api("/computers/stop", { method: "POST" }).catch(() => undefined);
  site?.stop(true);
  await rm(root, { recursive: true, force: true });
}, 30_000);

describe.skipIf(!asked)("a browser a person can take over", () => {
  test("is full Chromium rather than the headless shell", async () => {
    const page = `http://127.0.0.1:${site?.port}/`;
    const navigated = await api("/navigate", {
      method: "POST",
      body: JSON.stringify({ url: page }),
    });
    expect(navigated.status).toBe(200);

    const read = await api("/read");
    const body = (await read.json()) as { text?: string };
    expect(body.text).not.toContain("HeadlessChrome");
    expect(body.text).toContain("webdriver=false");
  }, 30_000);
});

type Element = { ref: string; role: string; name: string; value?: string };
type Snapshot = { snapshotId: number; elements: Element[] };

async function post(path: string, body: unknown) {
  const response = await api(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function snapshot() {
  const taken = await post("/snapshot", {});
  expect(taken.status).toBe(200);
  const page = taken.body as unknown as Snapshot;
  return {
    ...page,
    ref(name: string) {
      const found = page.elements.find((element) => element.name === name);
      if (!found) throw new Error(`No ${name} in the snapshot.`);
      return found.ref;
    },
    value(name: string) {
      return page.elements.find((element) => element.name === name)?.value;
    },
  };
}

/** The sign-up form, filled in apart from its dropdown, with the dropdown clicked open as a Bot did. */
async function formWithListOpen() {
  const navigated = await post("/navigate", {
    url: `http://127.0.0.1:${site?.port}/sign-up`,
  });
  expect(navigated.status).toBe(200);
  const form = await snapshot();
  for (const [name, text] of [
    ["Full name", "Dana Fresh"],
    ["Email", "dana@example.com"],
    ["Note", "Count me in"],
  ]) {
    const typed = await post("/type", {
      ref: form.ref(name),
      snapshotId: form.snapshotId,
      text,
    });
    expect(typed.status).toBe(200);
  }
  const opened = await post("/click", {
    ref: form.ref("Favourite plant"),
    snapshotId: form.snapshotId,
  });
  expect(opened.status).toBe(200);
  return form;
}

/** Send the form with its button, and return what arrived. */
async function signUp() {
  const page = await snapshot();
  const sent = await post("/click", {
    ref: page.ref("Sign up"),
    snapshotId: page.snapshotId,
  });
  expect(sent.status).toBe(200);
  return signUps.at(-1);
}

/**
 * Enter after choosing from a dropdown that was clicked open.
 *
 * A Bot clicked a dropdown, which opened the browser's own list, then typed its choice, which picks it
 * without the list knowing. The list still highlighted "Choose one", and the Enter the Bot pressed next
 * went to the list, which accepted its highlight: the choice was gone before the form was sent.
 */
describe.skipIf(!asked)(
  "Enter after choosing from a dropdown clicked open",
  () => {
    test("pressed on the page, it keeps the choice, and the form is sent with it", async () => {
      const form = await formWithListOpen();
      const chosen = await post("/type", {
        ref: form.ref("Favourite plant"),
        snapshotId: form.snapshotId,
        text: "Basil",
      });
      expect(chosen.status).toBe(200);
      expect((await post("/key", { key: "Enter" })).status).toBe(200);

      expect((await snapshot()).value("Favourite plant")).toBe("Basil");
      const arrived = await signUp();
      expect(arrived?.get("full_name")).toBe("Dana Fresh");
      expect(arrived?.get("plant")).toBe("Basil");
      expect(arrived?.get("note")).toBe("Count me in");
    }, 60_000);

    test("pressed on the dropdown itself, or sent with the typed choice, it keeps the choice", async () => {
      let form = await formWithListOpen();
      await post("/type", {
        ref: form.ref("Favourite plant"),
        snapshotId: form.snapshotId,
        text: "Basil",
      });
      const pressed = await post("/key", {
        ref: form.ref("Favourite plant"),
        snapshotId: form.snapshotId,
        key: "Enter",
      });
      expect(pressed.status).toBe(200);
      expect((await snapshot()).value("Favourite plant")).toBe("Basil");

      form = await formWithListOpen();
      const submitted = await post("/type", {
        ref: form.ref("Favourite plant"),
        snapshotId: form.snapshotId,
        text: "Basil",
        submit: true,
      });
      expect(submitted.status).toBe(200);
      expect((await snapshot()).value("Favourite plant")).toBe("Basil");
    }, 60_000);

    test("choosing in the open list with the arrow keys and Enter still works as it does for a person", async () => {
      await formWithListOpen();
      for (const key of ["ArrowDown", "ArrowDown", "Enter"]) {
        expect((await post("/key", { key })).status).toBe(200);
      }
      expect((await snapshot()).value("Favourite plant")).toBe("Basil");
      expect((await signUp())?.get("plant")).toBe("Basil");
    }, 60_000);
  },
);

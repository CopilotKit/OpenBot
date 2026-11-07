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
 * A sign-up form like the one a Bot could not send: text fields, a native dropdown, a note and a
 * button, laid out so the dropdown's list opens over the note and the button.
 */
const SIGN_UP = (
  action: string,
) => `<!doctype html><title>Garden Club Sign-up</title>
<style>body{font-family:sans-serif;max-width:520px;margin:40px auto}label{display:block;margin:14px 0 4px}input,select,textarea{width:100%;padding:8px;box-sizing:border-box}button{margin-top:18px;padding:10px 18px}</style>
<h1>Garden Club Sign-up</h1>
<form method="post" action="${action}">
<label for="full_name">Full name</label><input id="full_name" name="full_name" required>
<label for="email">Email</label><input id="email" name="email" type="email" required>
<label for="plant">Favourite plant</label>
<select id="plant" name="plant"><option value="">Choose one</option><option>Tomato</option><option>Basil</option><option>Sunflower</option><option>Fern</option></select>
<label for="note">Note</label><textarea id="note" name="note" rows="3"></textarea>
<button type="submit">Sign up</button>
</form>`;

/** A button under a cookie banner that covers the whole page. */
const COVERED = `<!doctype html><title>Covered</title>
<button>Sign up</button>
<div id="cookie-banner" class="banner bottom" style="position:fixed;inset:0;background:#0003">We use cookies.</div>`;

/** A button that takes another one off the page, so a ref can name an element that has gone. */
const VANISHING = `<!doctype html><title>Vanishing</title>
<button onclick="document.getElementById('go').remove()">Remove it</button>
<button id="go">Sign up</button>`;

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
  // A short action timeout, so the cases below that wait it out take seconds rather than ten.
  process.env.ACTION_TIMEOUT_MS = "3000";
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // A form still being sent is held open longer than the action waits.
    idleTimeout: 60,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/sign-up") return html(SIGN_UP("/signed-up"));
      if (pathname === "/sign-up-slow") return html(SIGN_UP("/never-answers"));
      // The page's own security policy forbids sending any form, as the test inbox's pages did.
      if (pathname === "/sign-up-refused") {
        const page = html(SIGN_UP("/signed-up"));
        page.headers.set("content-security-policy", "form-action 'none'");
        return page;
      }
      if (pathname === "/covered") return html(COVERED);
      if (pathname === "/vanishing") return html(VANISHING);
      if (pathname === "/signed-up" && request.method === "POST") {
        signUps.push(new URLSearchParams(await request.text()));
        return html(
          "<!doctype html><title>Signed up</title><h1>Thanks, you are signed up.</h1>",
        );
      }
      if (pathname === "/never-answers") {
        await Bun.sleep(30_000);
        return html("<!doctype html><title>Late</title>");
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

/** Open a page of the test site and take the snapshot a Bot would act from. */
async function open(path: string) {
  const navigated = await post("/navigate", {
    url: `http://127.0.0.1:${site?.port}${path}`,
  });
  expect(navigated.status).toBe(200);
  return snapshot();
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

/**
 * A Bot filling in and sending a form, on a browser a person can watch.
 *
 * Found on Windows: a Bot filled a sign-up form, chose from its dropdown and clicked Sign up. The
 * page's own security policy (`form-action 'none'`) refused to send the form, so no navigation began
 * and the click waited for one until it timed out. The server read every timeout as an element that
 * had gone, and told the Bot nine times that a Sign up button in plain view was "not on the page any
 * more". The dropdown was suspected first: its list, opened by the Bot's click, is drawn by the
 * browser outside the page. It does not stop a later click, which the first case pins.
 */
describe.skipIf(!asked)("a Bot sending a form", () => {
  test("clicking the dropdown open and typing a choice does not stop the form being sent", async () => {
    const form = await open("/sign-up");
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
    // As the Bot did: click the dropdown first, which opens its list over the note and the button,
    // then type the choice.
    const clicked = await post("/click", {
      ref: form.ref("Favourite plant"),
      snapshotId: form.snapshotId,
    });
    expect(clicked.status).toBe(200);
    const chosen = await post("/type", {
      ref: form.ref("Favourite plant"),
      snapshotId: form.snapshotId,
      text: "Basil",
    });
    expect(chosen.status).toBe(200);

    const checked = await snapshot();
    expect(checked.value("Favourite plant")).toBe("Basil");
    const sent = await post("/click", {
      ref: checked.ref("Sign up"),
      snapshotId: checked.snapshotId,
    });
    expect(sent.body.error).toBeUndefined();
    expect(sent.status).toBe(200);
    expect(String(sent.body.url)).toContain("/signed-up");

    const arrived = signUps.at(-1);
    expect(arrived?.get("full_name")).toBe("Dana Fresh");
    expect(arrived?.get("email")).toBe("dana@example.com");
    expect(arrived?.get("plant")).toBe("Basil");
    expect(arrived?.get("note")).toBe("Count me in");
  }, 60_000);

  test("a form the page refuses to send says so, by click and by Enter, and never that the button has gone", async () => {
    const before = signUps.length;
    for (const how of ["click", "enter"] as const) {
      const form = await open("/sign-up-refused");
      for (const [name, text] of [
        ["Full name", "Dana Fresh"],
        ["Email", "dana@example.com"],
        ["Favourite plant", "Basil"],
      ]) {
        await post("/type", {
          ref: form.ref(name),
          snapshotId: form.snapshotId,
          text,
        });
      }
      const target = { ref: form.ref("Sign up"), snapshotId: form.snapshotId };
      const sent =
        how === "click"
          ? await post("/click", target)
          : await post("/key", { ...target, key: "Enter" });
      expect(sent.status).toBe(409);
      expect(sent.body.unfinished).toBe("refused");
      const said = String(sent.body.error);
      expect(said).toContain("refused to send the form");
      expect(said).not.toContain("not on the page");
      expect(said).not.toContain("fresh snapshot");
      // Neither Playwright's call log nor the address the page posts to.
      expect(said).not.toContain("Call log");
      expect(said).not.toContain("/signed-up");
    }
    expect(signUps.length).toBe(before);
  }, 60_000);

  test("a click something covers says what is in the way, and never that the element has gone", async () => {
    const page = await open("/covered");
    const clicked = await post("/click", {
      ref: page.ref("Sign up"),
      snapshotId: page.snapshotId,
    });
    expect(clicked.status).toBe(409);
    expect(clicked.body.unfinished).toBe("covered");
    const said = String(clicked.body.error);
    expect(said).toContain("covering");
    expect(said).toContain("div#cookie-banner.banner.bottom");
    expect(said).not.toContain("not on the page");
    // Neither Playwright's call log nor the page's own words.
    expect(said).not.toContain("Call log");
    expect(said).not.toContain("We use cookies");
  }, 30_000);

  test("a click or an Enter whose form is still being sent says so, and not to send it again", async () => {
    for (const how of ["click", "enter"] as const) {
      const form = await open("/sign-up-slow");
      for (const [name, text] of [
        ["Full name", "Dana Fresh"],
        ["Email", "dana@example.com"],
      ]) {
        await post("/type", {
          ref: form.ref(name),
          snapshotId: form.snapshotId,
          text,
        });
      }
      const target = { ref: form.ref("Sign up"), snapshotId: form.snapshotId };
      const sent =
        how === "click"
          ? await post("/click", target)
          : await post("/key", { ...target, key: "Enter" });
      expect(sent.status).toBe(409);
      expect(sent.body.unfinished).toBe("loading");
      expect(String(sent.body.error)).toContain("Don't do it again");
      expect(String(sent.body.error)).not.toContain("not on the page");
    }
  }, 60_000);

  test("a ref whose element has left the page is still a stale ref", async () => {
    const page = await open("/vanishing");
    // The page changes under the snapshot: the same snapshot, the button gone.
    const removed = await post("/click", {
      ref: page.ref("Remove it"),
      snapshotId: page.snapshotId,
    });
    expect(removed.status).toBe(200);
    const clicked = await post("/click", {
      ref: page.ref("Sign up"),
      snapshotId: page.snapshotId,
    });
    expect(clicked.status).toBe(409);
    expect(clicked.body.stale).toBe(true);
    expect(clicked.body.unfinished).toBeUndefined();
  }, 30_000);
});

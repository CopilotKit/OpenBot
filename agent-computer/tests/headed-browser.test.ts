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

/** One button, clicked until the browser draws (see `untilTheBrowserDraws`). */
const READY = `<!doctype html><title>Ready</title>
<button>Ready</button>`;

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
      if (pathname === "/ready") return html(READY);
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
  await untilTheBrowserDraws();
}, 120_000);

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

type Answer = {
  path: string;
  status: number;
  body: Record<string, unknown>;
  /** The body as sent, for a failure message: it may not be JSON. */
  text: string;
};

async function post(path: string, body: unknown): Promise<Answer> {
  const response = await api(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON: `text` carries it into the failure message.
  }
  return { path, status: response.status, body: parsed, text };
}

/**
 * The status an action was expected to answer, and when it is another, what the computer said.
 *
 * A 502's body is the computer's account of the failure: for a click, Playwright's error with its
 * call log, which says which wait ran out (actionability, the click itself, or what it set off).
 * Asserting the status alone left a CI failure reading "Expected: 200, Received: 502" and nothing
 * else, with no way to tell those apart.
 */
function expectStatus(answer: Answer, status: number) {
  if (answer.status !== status) {
    throw new Error(
      `${answer.path} answered ${answer.status}, expected ${status}. The computer said:\n${answer.text}`,
    );
  }
}

/** Open a page of the test site and take the snapshot a Bot would act from. */
async function open(path: string) {
  const navigated = await post("/navigate", {
    url: `http://127.0.0.1:${site?.port}${path}`,
  });
  expectStatus(navigated, 200);
  return snapshot();
}

async function snapshot() {
  const taken = await post("/snapshot", {});
  expectStatus(taken, 200);
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
 * Start the browser and click until it has drawn, before any case times an action.
 *
 * A click first waits for its element to be stable, which takes two animation frames, and a headed
 * browser's frames come from its GPU process. Navigating, reading and typing need none. So the first
 * click of a browser whose GPU process is not drawing yet waits for it, and the first case's dropdown
 * click was that first click: on CI runners whose headed launch took 7.7 to 9 seconds, it ran out
 * the 3 seconds this file gives an action and answered 502, while every later case passed. Holding
 * the GPU process as the browser starts gives the same failure, with the call log stopped at
 * "waiting for element to be visible, enabled and stable".
 *
 * The cases pin what the computer answers, not how soon a cold browser draws, so the browser is
 * brought that far here. Every click that has to wait is printed with what the computer said, so a
 * slow start stays visible in the log.
 */
async function untilTheBrowserDraws() {
  const ready = await open("/ready");
  const deadline = Date.now() + 90_000;
  for (;;) {
    const clicked = await post("/click", {
      ref: ready.ref("Ready"),
      snapshotId: ready.snapshotId,
    });
    if (clicked.status === 200) return;
    if (Date.now() > deadline) expectStatus(clicked, 200);
    console.info(
      `The browser has not drawn yet. The click answered ${clicked.status}:\n${clicked.text}`,
    );
  }
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
      expectStatus(typed, 200);
    }
    // As the Bot did: click the dropdown first, which opens its list over the note and the button,
    // then type the choice.
    const clicked = await post("/click", {
      ref: form.ref("Favourite plant"),
      snapshotId: form.snapshotId,
    });
    expectStatus(clicked, 200);
    const chosen = await post("/type", {
      ref: form.ref("Favourite plant"),
      snapshotId: form.snapshotId,
      text: "Basil",
    });
    expectStatus(chosen, 200);

    const checked = await snapshot();
    expect(checked.value("Favourite plant")).toBe("Basil");
    const sent = await post("/click", {
      ref: checked.ref("Sign up"),
      snapshotId: checked.snapshotId,
    });
    // The status with the whole body, which the error alone would leave out.
    expectStatus(sent, 200);
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
      expectStatus(sent, 409);
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
    expectStatus(clicked, 409);
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
      expectStatus(sent, 409);
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
    expectStatus(removed, 200);
    const clicked = await post("/click", {
      ref: page.ref("Sign up"),
      snapshotId: page.snapshotId,
    });
    expectStatus(clicked, 409);
    expect(clicked.body.stale).toBe(true);
    expect(clicked.body.unfinished).toBeUndefined();
  }, 30_000);
});

/** The sign-up form, filled in apart from its dropdown, with the dropdown clicked open as a Bot did. */
async function formWithListOpen() {
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
    expectStatus(typed, 200);
  }
  const opened = await post("/click", {
    ref: form.ref("Favourite plant"),
    snapshotId: form.snapshotId,
  });
  expectStatus(opened, 200);
  return form;
}

/** Send the form with its button, and return what arrived. */
async function signUp() {
  const page = await snapshot();
  const sent = await post("/click", {
    ref: page.ref("Sign up"),
    snapshotId: page.snapshotId,
  });
  expectStatus(sent, 200);
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
      expectStatus(chosen, 200);
      expectStatus(await post("/key", { key: "Enter" }), 200);

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
      expectStatus(pressed, 200);
      expect((await snapshot()).value("Favourite plant")).toBe("Basil");

      form = await formWithListOpen();
      const submitted = await post("/type", {
        ref: form.ref("Favourite plant"),
        snapshotId: form.snapshotId,
        text: "Basil",
        submit: true,
      });
      expectStatus(submitted, 200);
      expect((await snapshot()).value("Favourite plant")).toBe("Basil");
    }, 60_000);

    test("choosing in the open list with the arrow keys and Enter still works as it does for a person", async () => {
      await formWithListOpen();
      for (const key of ["ArrowDown", "ArrowDown", "Enter"]) {
        expectStatus(await post("/key", { key }), 200);
      }
      expect((await snapshot()).value("Favourite plant")).toBe("Basil");
      expect((await signUp())?.get("plant")).toBe("Basil");
    }, 60_000);
  },
);

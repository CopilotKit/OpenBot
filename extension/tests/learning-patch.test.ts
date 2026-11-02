// The Recorder's clicks and typing come from CopilotKit main's own capture code. npm's @copilotkit/learning 0.0.1
// predates main, so a Bun patch (patches/@copilotkit%2Flearning@0.0.1.patch, named in the root package.json's
// patchedDependencies) swaps main's build in. That build carries masking the Recorder relies on: the name it gives a
// clicked control (`target.label`) has every URL, email address, token and typed password taken out before it leaves
// the page. Bun applies a patch only to the exact version it names, and a bump to any other version installs that
// version unpatched without a word. These tests break CI when that happens: the patch must name the version installed,
// and the installed collector must mask a control's name as main's does, whatever version that is.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  createTrajectoryCollector,
  type TrajectoryEvent,
} from "@copilotkit/learning";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { REDACTED } from "@openbot/shared/recorder-masking";

/**
 * A payment provider's secret key, made up, built here so the file holds no string shaped like a live key: secret
 * scanners (GitHub's push protection among them) refuse a push that carries one, fake or not.
 */
const PAYMENT_KEY = ["sk", "live", "51H8xQ2eZvKYlo2C0aBcDeFgHiJkLmNoP"].join(
  "_",
);

const ROOT = join(import.meta.dir, "..", "..");
const PACKAGE = "@copilotkit/learning";

beforeAll(() =>
  GlobalRegistrator.register({ url: "https://crm.example.test/deals/42" }),
);
afterAll(() => GlobalRegistrator.unregister());

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  document.body.innerHTML = "";
});

/** happy-dom cannot make a trusted event, and the collector hears only those: this one is marked trusted by hand. */
function trusted<E extends Event>(event: E): E {
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}

/** The installed collector, as the Recorder's content script runs it (content/collector.ts): clicks and edits only. */
function collect(): TrajectoryEvent[] {
  const sent: TrajectoryEvent[] = [];
  const collector = createTrajectoryCollector({
    capture: { clicks: true, inputs: true, navigation: false, network: false },
    send: (event) => {
      sent.push(event);
    },
  });
  collector.start();
  stops.push(() => collector.stop());
  return sent;
}

function click(element: Element): void {
  element.dispatchEvent(
    trusted(new MouseEvent("click", { bubbles: true, detail: 1 })),
  );
}

/** The name the collector gave each clicked control, in order. */
const labels = (sent: TrajectoryEvent[]) =>
  sent
    .filter((event) => event.name === "click")
    .map(
      (event) =>
        (event.value as { target?: { label?: string } } | null)?.target?.label,
    );

test("the patch names the version of @copilotkit/learning that is installed, and its file is there", () => {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ) as { patchedDependencies?: Record<string, string> };
  const installed = (
    createRequire(join(import.meta.dir, "..", "package.json"))(
      `${PACKAGE}/package.json`,
    ) as { version: string }
  ).version;
  const patches = Object.entries(manifest.patchedDependencies ?? {}).filter(
    ([name]) => name.startsWith(`${PACKAGE}@`),
  );
  // Once CopilotKit main is published the patch goes, and the masking test below is what holds the version to it.
  for (const [name, file] of patches) {
    expect(name).toBe(`${PACKAGE}@${installed}`);
    expect(existsSync(join(ROOT, file))).toBe(true);
  }
});

test("the installed collector names a clicked control with every address, email, token and typed password taken out", () => {
  const sent = collect();
  document.body.innerHTML = `
    <label>Password <input id="password" type="password"></label>
    <button id="email" aria-label="Email ada.lovelace@example.test"></button>
    <a id="address" href="/deals/42">Open https://crm.example.test/deals/42?token=abc</a>
    <button id="jwt">Session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.c2lnbmF0dXJl</button>
    <button id="token">Key ${PAYMENT_KEY}</button>
    <button id="typed">Use hunter2-correct-horse</button>
    <button id="plain">Save deal</button>`;
  const password = document.getElementById("password") as HTMLInputElement;
  password.focus();
  password.value = "hunter2-correct-horse";
  password.dispatchEvent(trusted(new InputEvent("input", { bubbles: true })));
  for (const id of ["email", "address", "jwt", "token", "typed", "plain"])
    click(document.getElementById(id) as Element);

  expect(labels(sent)).toEqual([
    "Email [email]",
    "Open [url]",
    `Session ${REDACTED}`,
    `Key ${REDACTED}`,
    `Use ${REDACTED}`,
    "Save deal",
  ]);
  // The collector's raw `text` is the page's own, which the Recorder masks itself (recorder-masking.ts); the name is
  // what the patch masks in the page, and nothing secret is left in it.
  for (const secret of [
    "ada.lovelace@example.test",
    "crm.example.test",
    "eyJzdWIiOjF9",
    PAYMENT_KEY,
    "hunter2-correct-horse",
  ])
    expect(labels(sent).join(" ")).not.toContain(secret);
});

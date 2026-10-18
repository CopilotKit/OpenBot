import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  isNoticeEvent,
  NOTICE_TAG,
  NOTICE_TOKENS,
  showNotice,
} from "../src/content/notice";
import { startStepCapture } from "../src/content/steps";

beforeAll(() =>
  GlobalRegistrator.register({ url: "https://app.example.test/page" }),
);
afterAll(() => GlobalRegistrator.unregister());

let shown: { remove(): void } | undefined;
afterEach(() => {
  shown?.remove();
  shown = undefined;
  document.body.innerHTML = "";
});

function show(choose: (choice: "stop" | "restart" | "continue") => void) {
  const notice = showNotice({ steps: 50, choose, isTrusted: () => true });
  shown = notice;
  return notice;
}

function button(host: HTMLElement, name: string): HTMLButtonElement {
  const found = [...(host.shadowRoot?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no ${name} button`);
  return found as HTMLButtonElement;
}

function customProperties(
  css: string,
  selector: RegExp,
): Record<string, string> {
  const block = selector.exec(css)?.[1] ?? "";
  const vars: Record<string, string> = {};
  for (const match of block.matchAll(/(--[a-z-]+):\s*([^;]+);/g)) {
    vars[match[1] as string] = (match[2] as string).trim();
  }
  return vars;
}

test("the notice is never recorded", async () => {
  const notice = show(() => {});
  const sent: unknown[] = [];
  const steps = startStepCapture({
    send: (a) => sent.push(a),
    isIgnored: (t, path) => isNoticeEvent(t, path),
    isTrusted: () => true,
  });
  notice.host.dispatchEvent(
    new MouseEvent("click", { bubbles: true, composed: true, button: 0 }),
  );
  button(notice.host, "Stop").dispatchEvent(
    new MouseEvent("click", { bubbles: true, composed: true, button: 0 }),
  );
  expect(sent).toEqual([]);
  steps.stop();
});

test("the notice host is ignored by the capture and marked data-copilotkit-ignore", () => {
  const notice = show(() => {});
  expect(notice.host.tagName.toLowerCase()).toBe(NOTICE_TAG);
  expect(notice.host.hasAttribute("data-copilotkit-ignore")).toBe(true);
  expect(isNoticeEvent(notice.host, [notice.host])).toBe(true);
  expect(isNoticeEvent(document.body, [document.body])).toBe(false);
  expect(isNoticeEvent(null, [])).toBe(false);
});

test("the notice offers Stop, Start over and Keep going", () => {
  const choices: string[] = [];
  const notice = show((c) => choices.push(c));
  const root = notice.host.shadowRoot as ShadowRoot;
  expect(root.querySelector("[role=dialog]")).not.toBeNull();
  expect(root.textContent).toContain("You have recorded 50 steps");
  expect(root.textContent).toContain(
    "Click Stop if the task is done, start over if it went wrong, or keep going if it needs more.",
  );
  button(notice.host, "Stop").click();
  button(notice.host, "Start over").click();
  button(notice.host, "Keep going").click();
  expect(choices).toEqual(["stop", "restart", "continue"]);
});

test("Escape means Keep going", () => {
  const choices: string[] = [];
  const notice = show((c) => choices.push(c));
  button(notice.host, "Stop").dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      composed: true,
    }),
  );
  expect(choices).toEqual(["continue"]);
});

test("a page script clicking the notice does nothing", () => {
  const choices: string[] = [];
  const notice = showNotice({
    steps: 50,
    choose: (c) => choices.push(c),
  });
  shown = notice;
  button(notice.host, "Stop").click();
  button(notice.host, "Start over").click();
  notice.host.shadowRoot?.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      composed: true,
    }),
  );
  expect(choices).toEqual([]);
});

test("the notice sits above the page, fixed bottom-right, and removes itself", () => {
  const notice = show(() => {});
  const css = notice.host.shadowRoot?.querySelector("style")?.textContent ?? "";
  expect(css).toContain("2147483647");
  expect(css).toContain("prefers-color-scheme: dark");
  expect(document.querySelector(NOTICE_TAG)).toBe(notice.host);
  notice.remove();
  expect(document.querySelector(NOTICE_TAG)).toBeNull();
});

test("the notice's colours are OpenBot's", () => {
  const css = readFileSync(
    join(import.meta.dir, "../../app/src/theme.css"),
    "utf8",
  );
  const light = customProperties(css, /:root\s*\{([^}]*)\}/);
  const dark = customProperties(css, /\.dark\s*\{([^}]*)\}/);
  expect(Object.keys(NOTICE_TOKENS.light).sort()).toEqual(
    [
      "--background",
      "--foreground",
      "--card",
      "--card-foreground",
      "--border",
      "--primary",
      "--primary-foreground",
      "--muted-foreground",
      "--ring",
    ].sort(),
  );
  for (const [name, value] of Object.entries(NOTICE_TOKENS.light)) {
    expect<string>(value).toBe(light[name] as string);
  }
  for (const [name, value] of Object.entries(NOTICE_TOKENS.dark)) {
    expect<string>(value).toBe(dark[name] as string);
  }
  const radius = light["--radius"];
  const notice = show(() => {});
  const style =
    notice.host.shadowRoot?.querySelector("style")?.textContent ?? "";
  expect(style).toContain(`--radius: ${radius}`);
  for (const value of Object.values(NOTICE_TOKENS.light)) {
    expect(style).toContain(value);
  }
  for (const value of Object.values(NOTICE_TOKENS.dark)) {
    expect(style).toContain(value);
  }
});

test("the focus ring follows the theme's --ring in light and dark", () => {
  const css = readFileSync(
    join(import.meta.dir, "../../app/src/theme.css"),
    "utf8",
  );
  const dark = customProperties(css, /\.dark\s*\{([^}]*)\}/);
  const notice = show(() => {});
  const style =
    notice.host.shadowRoot?.querySelector("style")?.textContent ?? "";
  const focusRule = /button:focus-visible\s*\{([^}]*)\}/.exec(style)?.[1] ?? "";
  expect(focusRule).toContain("var(--ring)");
  expect(focusRule).not.toContain(NOTICE_TOKENS.light["--ring"]);
  expect(focusRule).not.toMatch(/oklch\(/);
  const darkBlock =
    /prefers-color-scheme: dark\)\s*\{\s*:host\s*\{([^}]*)\}/.exec(style)?.[1];
  expect(darkBlock).toContain(`--ring: ${dark["--ring"]};`);
});

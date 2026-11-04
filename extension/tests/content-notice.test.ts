import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { startEventCapture } from "../src/content/collector";
import { createSensitivityTracker } from "../src/content/masking-context";
import { NOTICE_TAG, NOTICE_TOKENS, showNotice } from "../src/content/notice";

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
  const notice = showNotice({ actions: 50, choose, isTrusted: () => true });
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

/** happy-dom cannot make trusted events; the collector listens only for them, so these are marked trusted by hand. */
const trustedClick = () => {
  const event = new MouseEvent("click", {
    bubbles: true,
    composed: true,
    button: 0,
  });
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
};

test("a click on the notice is never captured, so it never counts as an action", () => {
  document.body.innerHTML = `<button id="b">Save</button>`;
  const notice = show(() => {});
  const tracker = createSensitivityTracker({ isTrusted: () => true });
  const uninstall = tracker.install();
  const sent: CapturedEvent[] = [];
  const capture = startEventCapture({
    tracker,
    send: (event) => sent.push(event),
  });
  try {
    notice.host.dispatchEvent(trustedClick());
    button(notice.host, "Stop").dispatchEvent(trustedClick());
    expect(sent.filter((event) => event.name === "click")).toEqual([]);
    // The page's own button is captured as usual.
    (document.getElementById("b") as HTMLElement).dispatchEvent(trustedClick());
    expect(sent.filter((event) => event.name === "click")).toHaveLength(1);
  } finally {
    capture.stop();
    uninstall();
  }
});

test("the notice host is marked data-copilotkit-ignore", () => {
  const notice = show(() => {});
  expect(notice.host.tagName.toLowerCase()).toBe(NOTICE_TAG);
  expect(notice.host.hasAttribute("data-copilotkit-ignore")).toBe(true);
});

test("the notice offers Stop, Start over and Keep going", () => {
  const choices: string[] = [];
  const notice = show((c) => choices.push(c));
  const root = notice.host.shadowRoot as ShadowRoot;
  expect(root.querySelector("[role=dialog]")).not.toBeNull();
  expect(root.textContent).toContain("You have recorded 50 or more actions");
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
    actions: 50,
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
      "--secondary",
      "--muted-foreground",
      "--destructive",
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

test("the primary button dims to 80% of the primary token on hover", () => {
  const notice = show(() => {});
  const style =
    notice.host.shadowRoot?.querySelector("style")?.textContent ?? "";
  const hoverRule =
    /button\.primary:hover\s*\{([^}]*)\}/.exec(style)?.[1] ?? "";
  expect(hoverRule).toContain("var(--primary) 80%");
  expect(hoverRule).not.toMatch(/oklch\(\d/);
});

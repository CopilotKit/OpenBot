import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { startEventCapture } from "../src/content/collector";
import {
  type Box,
  chooseSpot,
  coveredIn,
  INDICATOR_TAG,
  type IndicatorView,
  type MarkSpot,
  showIndicator,
  spotBox,
} from "../src/content/indicator";
import { createSensitivityTracker } from "../src/content/masking-context";
import { NOTICE_TOKENS } from "../src/content/notice";

/**
 * The recording mark a followed tab shows from its first step (content/indicator.ts): what it says, the one click that
 * leaves the site out of every recording or records it again, and that a page cannot press it for the person.
 */

beforeAll(() =>
  GlobalRegistrator.register({ url: "https://mail.example.test/inbox" }),
);
afterAll(() => GlobalRegistrator.unregister());

let shown: { remove(): void } | undefined;
afterEach(() => {
  shown?.remove();
  shown = undefined;
  document.body.innerHTML = "";
});

const RECORDING: IndicatorView = {
  site: "example.test",
  excluded: false,
  narrating: false,
};

function show(
  view: IndicatorView,
  choose: (recorded: boolean) => void = () => {},
  trusted = true,
) {
  const mark = showIndicator({
    view,
    choose,
    ...(trusted ? { isTrusted: () => true } : {}),
  });
  shown = mark;
  return mark;
}

/** What the mark shows, part by part, as a person reads it. */
const text = (host: HTMLElement) =>
  [...(host.shadowRoot?.querySelectorAll(".label, .voice, button") ?? [])]
    .filter((part) => !(part as HTMLElement).hidden)
    .map((part) => part.textContent)
    .join(" ");
const buttonOf = (host: HTMLElement) =>
  host.shadowRoot?.querySelector("button") as HTMLButtonElement;

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

test("a recorded tab says OpenBot is recording it, with one button that leaves its site out", () => {
  const choices: boolean[] = [];
  const mark = show(RECORDING, (recorded) => choices.push(recorded));
  expect(document.querySelector(INDICATOR_TAG)).toBe(mark.host);
  expect(text(mark.host)).toBe(
    "OpenBot is recording this tab Don't record example.test",
  );
  expect(
    mark.host.shadowRoot?.querySelector("[role=status]")?.textContent,
  ).toContain("OpenBot is recording this tab");
  buttonOf(mark.host).click();
  expect(choices).toEqual([false]);
});

test("while the Recorder hears the person, the mark says so", () => {
  const mark = show({ ...RECORDING, narrating: true });
  expect(text(mark.host)).toBe(
    "OpenBot is recording this tab · Listening to you Don't record example.test",
  );
  mark.update({ ...RECORDING, narrating: false });
  expect(text(mark.host)).toBe(
    "OpenBot is recording this tab Don't record example.test",
  );
});

test("a site left out says it is not recorded, and its button records it again", () => {
  const choices: boolean[] = [];
  const mark = show({ site: "example.test", excluded: true }, (recorded) =>
    choices.push(recorded),
  );
  expect(text(mark.host)).toBe("Not recording example.test Record it");
  buttonOf(mark.host).click();
  expect(choices).toEqual([true]);
  // The same mark turns back when the background says the site is recorded again.
  mark.update(RECORDING);
  expect(text(mark.host)).toBe(
    "OpenBot is recording this tab Don't record example.test",
  );
  buttonOf(mark.host).click();
  expect(choices).toEqual([true, false]);
});

test("a page script clicking the mark does nothing", () => {
  const choices: boolean[] = [];
  const mark = show(RECORDING, (recorded) => choices.push(recorded), false);
  buttonOf(mark.host).click();
  expect(choices).toEqual([]);
});

test("a click on the mark is never one of the person's steps", () => {
  document.body.innerHTML = `<button id="b">Send</button>`;
  const mark = show(RECORDING);
  expect(mark.host.hasAttribute("data-copilotkit-ignore")).toBe(true);
  const tracker = createSensitivityTracker({ isTrusted: () => true });
  const uninstall = tracker.install();
  const sent: CapturedEvent[] = [];
  const capture = startEventCapture({
    tracker,
    send: (event) => sent.push(event),
  });
  try {
    buttonOf(mark.host).dispatchEvent(trustedClick());
    expect(sent.filter((event) => event.name === "click")).toEqual([]);
    (document.getElementById("b") as HTMLElement).dispatchEvent(trustedClick());
    expect(sent.filter((event) => event.name === "click")).toHaveLength(1);
  } finally {
    capture.stop();
    uninstall();
  }
});

test("the mark sits above the page, in OpenBot's colours, and removes itself", () => {
  const mark = show(RECORDING);
  const css = mark.host.shadowRoot?.querySelector("style")?.textContent ?? "";
  expect(css).toContain("2147483647");
  expect(css).toContain("position: fixed");
  expect(css).toContain("prefers-color-scheme: dark");
  expect(css).toContain("prefers-reduced-motion");
  for (const value of [
    ...Object.values(NOTICE_TOKENS.light),
    ...Object.values(NOTICE_TOKENS.dark),
  ])
    expect(css).toContain(value);
  mark.remove();
  expect(document.querySelector(INDICATOR_TAG)).toBeNull();
});

// ---- Where the mark hangs ------------------------------------------------------------------------------------------
//
// End-to-end run 1 of the review fixes: on OpenBot's own tab the mark, then bottom-left, covered the sidebar's account
// row. What a person can use along the edges of OpenBot's home page, measured in Chromium 151 (headless, 2026-10-27,
// the self-host bar shown, as a new install shows it), at the sizes of a laptop and a desktop screen.

type Usable = { what: string; tag: "a" | "button" | "input"; box: Box };
const OPENBOT_HOME: Record<
  string,
  { page: { width: number; height: number }; usable: Usable[] }
> = {
  laptop: {
    page: { width: 1280, height: 860 },
    usable: [
      {
        what: "OpenBot",
        tag: "a",
        box: { left: 8, top: 8, width: 285, height: 34 },
      },
      {
        what: "New conversation",
        tag: "a",
        box: { left: 299, top: 8, width: 32, height: 32 },
      },
      {
        what: "Search conversations",
        tag: "input",
        box: { left: 33, top: 56, width: 297, height: 36 },
      },
      {
        what: "Bots",
        tag: "a",
        box: { left: 8, top: 648, width: 323, height: 40 },
      },
      {
        what: "Capabilities",
        tag: "a",
        box: { left: 8, top: 689, width: 323, height: 40 },
      },
      {
        what: "Connections",
        tag: "a",
        box: { left: 8, top: 730, width: 323, height: 40 },
      },
      {
        what: "Browser",
        tag: "button",
        box: { left: 8, top: 771, width: 323, height: 40 },
      },
      {
        what: "account row",
        tag: "button",
        box: { left: 8, top: 812, width: 323, height: 40 },
      },
      {
        what: "Toggle Sidebar",
        tag: "button",
        box: { left: 331, top: 0, width: 16, height: 860 },
      },
      {
        what: "Talk to an engineer",
        tag: "a",
        box: { left: 611, top: 6, width: 118, height: 28 },
      },
      {
        what: "Dismiss",
        tag: "button",
        box: { left: 737, top: 8, width: 24, height: 24 },
      },
      {
        what: "Get a license",
        tag: "a",
        box: { left: 672, top: 824, width: 81, height: 20 },
      },
    ],
  },
  desktop: {
    page: { width: 1920, height: 1080 },
    usable: [
      {
        what: "OpenBot",
        tag: "a",
        box: { left: 8, top: 8, width: 285, height: 34 },
      },
      {
        what: "New conversation",
        tag: "a",
        box: { left: 299, top: 8, width: 32, height: 32 },
      },
      {
        what: "account row",
        tag: "button",
        box: { left: 8, top: 1032, width: 323, height: 40 },
      },
      {
        what: "Toggle Sidebar",
        tag: "button",
        box: { left: 331, top: 0, width: 16, height: 1080 },
      },
      {
        what: "Talk to an engineer",
        tag: "a",
        box: { left: 611, top: 6, width: 118, height: 28 },
      },
      {
        what: "Dismiss",
        tag: "button",
        box: { left: 737, top: 8, width: 24, height: 24 },
      },
      {
        what: "Get a license",
        tag: "a",
        box: { left: 992, top: 1044, width: 81, height: 20 },
      },
    ],
  },
};
/** The mark on OpenBot's own tab, "OpenBot is recording this tab | Don't record 127.0.0.1", as Chromium drew it. */
const MARK_SIZE = { width: 361, height: 28 };

const inside = (box: Box, x: number, y: number) =>
  x >= box.left &&
  x < box.left + box.width &&
  y >= box.top &&
  y < box.top + box.height;
const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height;

/** The page as the browser's hit test answers it: the element drawn at a point, the smallest box there. */
function pageOf(usable: Usable[]) {
  const elements = usable.map((thing) => {
    const element = document.createElement(thing.tag);
    if (thing.tag === "a") element.setAttribute("href", "#");
    return { ...thing, element };
  });
  const background = document.createElement("main");
  return (x: number, y: number): Element =>
    elements
      .filter((thing) => inside(thing.box, x, y))
      .sort(
        (a, b) => a.box.width * a.box.height - b.box.width * b.box.height,
      )[0]?.element ?? background;
}

test("on OpenBot's own page the mark hangs where it covers nothing the person can use: not the account row, not the self-host bar's link or close button", () => {
  for (const [size, { page, usable }] of Object.entries(OPENBOT_HOME)) {
    const under = pageOf(usable);
    const spot = chooseSpot((candidate) =>
      coveredIn(spotBox(candidate, MARK_SIZE, page), under),
    );
    const box = spotBox(spot, MARK_SIZE, page);
    expect({
      size,
      covered: usable
        .filter((thing) => overlaps(box, thing.box))
        .map((thing) => thing.what),
    }).toEqual({
      size,
      covered: [],
    });
    expect(box.top).toBe(0);
    expect(box.left).toBeGreaterThanOrEqual(16);
    expect(box.left + box.width).toBeLessThanOrEqual(page.width - 16);
  }
  // On a laptop's screen the middle of the top edge is the self-host bar's link and close button, so it hangs right of
  // the middle; on a wider screen the middle is clear.
  const laptop = OPENBOT_HOME.laptop as (typeof OPENBOT_HOME)["laptop"];
  expect(
    chooseSpot((candidate) =>
      coveredIn(
        spotBox(candidate, MARK_SIZE, laptop.page),
        pageOf(laptop.usable),
      ),
    ),
  ).toEqual({ edge: "top", at: 0.75 });
  const desktop = OPENBOT_HOME.desktop as (typeof OPENBOT_HOME)["desktop"];
  expect(
    chooseSpot((candidate) =>
      coveredIn(
        spotBox(candidate, MARK_SIZE, desktop.page),
        pageOf(desktop.usable),
      ),
    ),
  ).toEqual({ edge: "top", at: 0.5 });
});

test("the mark moves only when something usable comes under it and a spot is clear, and never back for nothing", () => {
  const page = { width: 1280, height: 860 };
  const bar: Usable = {
    what: "banner link",
    tag: "a",
    box: { left: 560, top: 0, width: 160, height: 30 },
  };
  const clear = pageOf([]);
  const covers =
    (under: (x: number, y: number) => Element) => (spot: MarkSpot) =>
      coveredIn(spotBox(spot, MARK_SIZE, page), under);
  let spot = chooseSpot(covers(clear));
  expect(spot).toEqual({ edge: "top", at: 0.5 });
  // A banner draws late, its link under the mark: it moves to the first clear spot.
  spot = chooseSpot(covers(pageOf([bar])), spot);
  expect(spot).toEqual({ edge: "top", at: 0.75 });
  // The banner goes: it stays where it is, which covers nothing.
  spot = chooseSpot(covers(clear), spot);
  expect(spot).toEqual({ edge: "top", at: 0.75 });
  // Everything along both edges is usable: it goes where it covers least, and stays there on a tie.
  const crowded = pageOf([
    {
      what: "top bar",
      tag: "button",
      box: { left: 0, top: 0, width: 1280, height: 40 },
    },
    {
      what: "bottom bar",
      tag: "button",
      box: { left: 0, top: 820, width: 1280, height: 40 },
    },
  ]);
  expect(chooseSpot(covers(crowded), spot)).toEqual({ edge: "top", at: 0.75 });
});

test("the shown mark takes the spot the page leaves clear, hangs from that edge, and holds still under the pointer", () => {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return this.className === "mark"
      ? ({
          ...MARK_SIZE,
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: MARK_SIZE.width,
          bottom: MARK_SIZE.height,
        } as DOMRect)
      : rect.call(this);
  };
  const width = document.documentElement.clientWidth || window.innerWidth;
  const height = document.documentElement.clientHeight || window.innerHeight;
  // The whole top edge is a toolbar: the mark rises from the middle of the bottom edge.
  let usable: Usable[] = [
    {
      what: "toolbar",
      tag: "button",
      box: { left: 0, top: 0, width, height: 40 },
    },
  ];
  const looks: (() => void)[] = [];
  try {
    const mark = showIndicator({
      view: RECORDING,
      choose: () => {},
      isTrusted: () => true,
      under: (x, y) => pageOf(usable)(x, y),
      timers: { set: (fn) => looks.push(fn), clear: () => {} },
    });
    shown = mark;
    const edge = () =>
      mark.host.shadowRoot?.querySelector<HTMLElement>(".mark")?.dataset.edge;
    expect(edge()).toBe("bottom");
    expect(mark.host.style.getPropertyValue("top")).toBe(
      `${height - MARK_SIZE.height}px`,
    );
    expect(mark.host.style.getPropertyValue("left")).toBe(
      `${width / 2 - MARK_SIZE.width / 2}px`,
    );
    // The toolbar goes away while the person points at the mark: it does not move from under them.
    usable = [];
    mark.host.dispatchEvent(new Event("pointerenter"));
    for (const look of looks) look();
    expect(edge()).toBe("bottom");
    // Once they move away and a cookie banner comes up under it, it hangs from the top edge again.
    mark.host.dispatchEvent(new Event("pointerleave"));
    usable = [
      {
        what: "cookie banner",
        tag: "button",
        box: { left: 0, top: height - 60, width, height: 60 },
      },
    ];
    for (const look of looks) look();
    expect(edge()).toBe("top");
    expect(mark.host.style.getPropertyValue("top")).toBe("0px");
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
  }
});

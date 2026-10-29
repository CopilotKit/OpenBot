/**
 * The recording mark, drawn in the top frame of every tab a recording follows from the tab's first step until Stop: a
 * small tab hanging from the top edge of the page, saying the tab is being recorded (and that the Recorder hears the
 * person, while it does), with one button that leaves the site out of every recording. On a site the person left out it
 * says it is not recording it, with a button to record it again. A recording follows every tab the person uses, so the
 * mark is how they know which tabs it has, before a glance at a bank or a mailbox goes into it.
 *
 * Where it sits: on the top edge, where apps keep the least of what a person uses. A sidebar and its account row run
 * down the left (OpenBot's own account row is bottom-left), an account menu sits top-right, a chat launcher and the
 * 50-action notice bottom-right, and a chat's composer bottom-centre. It hangs from the middle of the top edge unless
 * something the person can use is right there (a link, a button, a field, a frame such as a chat launcher), and then
 * from the first spot that covers nothing of the kind: right of the middle, left of it, then the middle of the bottom
 * edge (`MARK_SPOTS`). OpenBot's own pages show why one fixed spot is not enough: the bar that offers help self-hosting
 * it has its link and its close button in the middle of the top edge on a laptop's screen. The page is looked at again
 * when its size changes and every couple of seconds, since an app draws its banners and launchers late, but the mark
 * never moves while the person points at it or it has the keyboard, and never for nothing: it stays where it is while
 * it covers nothing there, or while no spot covers less.
 *
 * Drawn like the notice: OpenBot's colours copied from app/src/theme.css (notice.ts), marked `data-copilotkit-ignore` so
 * a click on it is never one of the person's steps, and acting only on trusted events, so a page script cannot press its
 * button.
 *
 * THE PAGE CANNOT TAKE IT AWAY. It is the sign that a tab is being recorded, and it lives in the page's own DOM, so the
 * page could hide it with one CSS rule, or remove it, and nothing put it back. Now:
 * - Its shadow root is closed, so no page script can reach inside it (`host.shadowRoot` is null to the page). This
 *   content script's isolated world keeps its own globals, so the page cannot patch `attachShadow` to see it either.
 * - What makes it seen is set on its host from inside its shadow root, `!important`: `:host` rules of a shadow tree
 *   outrank, when important, every important rule of the page's and every inline style on the host (CSS Cascade 5,
 *   "context": https://www.w3.org/TR/css-cascade-5/#cascade-context; measured in Chromium against a page rule and an
 *   inline style, both `display: none !important`). Where it hangs is set on the mark inside, which the page cannot reach.
 * - Removed, or the document replaced, it is put back at once (a `MutationObserver` on the document), and the look it
 *   takes every couple of seconds puts it back too. It is kept the last child of the root element, so nothing the page
 *   adds there later is drawn over it at the same z-index, and `hidden` or `inert` set on it is taken off again. Kept last
 *   at most a few times a second, so another script that also wants to be last cannot make the two trade places forever.
 * A page can still put something of the browser's own top layer (a modal dialog) over it, as it can over anything.
 *
 * A test reaches inside through `root`, which only this content script holds; the end-to-end build (RECORDER_VARIANT
 * `e2e`) opens the root, so a harness driving a real page can press the mark's button as a person would.
 */
import { declarations, NOTICE_TOKENS, RADIUS } from "./notice";

export const INDICATOR_TAG = "openbot-recorder-mark";

export type IndicatorView = {
  /** The site the tab shows. */
  site: string;
  /** The person keeps it out of their recordings: nothing in the tab is recorded. */
  excluded: boolean;
  /** Whether the Recorder hears the person now; absent where it does not hear them itself. */
  narrating?: boolean;
};

/** The spots the mark may hang from, in the order it prefers them (`at`: where its middle is, across the page). */
export const MARK_SPOTS = [
  { edge: "top", at: 0.5 },
  { edge: "top", at: 0.75 },
  { edge: "top", at: 0.25 },
  { edge: "bottom", at: 0.5 },
] as const;
export type MarkSpot = (typeof MARK_SPOTS)[number];

export type Box = { left: number; top: number; width: number; height: number };

/** How far the mark keeps from the page's sides. */
const SIDE_GAP = 16;
/** How often the page is looked at again for what the mark covers. */
const LOOK_MS = 2_000;

/** The box the mark takes at `spot`, `size` its own, on a page `page` wide and high, kept inside the page's sides. */
export function spotBox(
  spot: MarkSpot,
  size: { width: number; height: number },
  page: { width: number; height: number },
): Box {
  const widest = Math.max(SIDE_GAP, page.width - SIDE_GAP - size.width);
  const left = Math.min(
    Math.max(SIDE_GAP, page.width * spot.at - size.width / 2),
    widest,
  );
  return {
    left,
    top: spot.edge === "top" ? 0 : page.height - size.height,
    width: size.width,
    height: size.height,
  };
}

/**
 * Where the mark goes: the first spot where it covers nothing the person can use (`covers` counts what it would cover
 * there), else the one where it covers least, earlier spots first. The spot it is at (`current`) is kept while it covers
 * nothing there, and while no other covers less, so the mark never moves for nothing.
 */
export function chooseSpot(
  covers: (spot: MarkSpot) => number,
  current?: MarkSpot,
): MarkSpot {
  const counts = MARK_SPOTS.map((spot) => ({ spot, count: covers(spot) }));
  const here = counts.find((entry) => entry.spot === current);
  if (here?.count === 0) return here.spot;
  let best = counts[0] as { spot: MarkSpot; count: number };
  for (const entry of counts) if (entry.count < best.count) best = entry;
  return here && here.count <= best.count ? here.spot : best.spot;
}

/** What a person can use on a page: what they click, type into or press, and a frame (a chat launcher is one). */
const USABLE = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "label",
  "iframe",
  "video",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
  ...[
    "button",
    "link",
    "tab",
    "menuitem",
    "checkbox",
    "radio",
    "switch",
    "combobox",
    "searchbox",
    "textbox",
    "slider",
    "option",
  ].map((role) => `[role='${role}']`),
].join(",");

/** The thing a person can use that `element` is, or is part of; a pointer cursor says the page made it clickable. */
function usable(element: Element): Element | null {
  const found = element.closest(USABLE);
  if (found) return found;
  return getComputedStyle(element).cursor === "pointer" ? element : null;
}

/** How many things a person can use lie under `box`, looked at every 24 px across it, at its top, middle and bottom. */
export function coveredIn(
  box: Box,
  under: (x: number, y: number) => Element | null,
): number {
  const found = new Set<Element>();
  const xs: number[] = [];
  for (let x = box.left + 4; x < box.left + box.width - 4; x += 24) xs.push(x);
  xs.push(box.left + box.width - 4);
  for (const y of [
    box.top + 4,
    box.top + box.height / 2,
    box.top + box.height - 4,
  ])
    for (const x of xs) {
      const element = under(x, y);
      const thing = element ? usable(element) : null;
      if (thing) found.add(thing);
    }
  return found.size;
}

type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

/** How many times the mark moves itself back to the end of the root element in one look (`LOOK_MS`), at most. */
const MOVES_PER_LOOK = 10;

const STYLE = `
:host {
  all: initial !important;
  display: block !important;
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 0 !important;
  height: 0 !important;
  overflow: visible !important;
  visibility: visible !important;
  opacity: 1 !important;
  transform: none !important;
  filter: none !important;
  clip-path: none !important;
  mask: none !important;
  pointer-events: auto !important;
  z-index: 2147483647 !important;
  --radius: ${RADIUS};
  ${declarations(NOTICE_TOKENS.light)}
}
@media (prefers-color-scheme: dark) {
  :host { ${declarations(NOTICE_TOKENS.dark)} }
}
.mark {
  position: fixed;
  top: 0;
  left: 0;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100vw - 32px);
  height: 28px;
  padding: 0 3px 0 12px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--card-foreground);
  box-shadow: 0 4px 12px oklch(0 0 0 / 12%), 0 1px 3px oklch(0 0 0 / 8%);
  font-family: "Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
}
/* Hanging from the edge it is on: no border along that edge, and its corners rounded away from it. */
.mark[data-edge="top"] { border-top: none; border-radius: 0 0 calc(var(--radius) * 1.2) calc(var(--radius) * 1.2); }
.mark[data-edge="bottom"] { border-bottom: none; border-radius: calc(var(--radius) * 1.2) calc(var(--radius) * 1.2) 0 0; }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--destructive); }
.mark[data-excluded] .dot { background: var(--muted-foreground); }
@media (prefers-reduced-motion: no-preference) {
  .mark:not([data-excluded]) .dot { animation: pulse 2s ease-in-out infinite; }
}
@keyframes pulse { 50% { opacity: 0.4; } }
/* On a narrow page the voice line gives way first, then the button's site name: what the mark says stays whole. */
.label { flex: none; font-weight: 500; }
.voice { flex: 0 1000 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--muted-foreground); }
button {
  box-sizing: border-box;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  height: 22px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: calc(var(--radius) * 0.8);
  background: transparent;
  color: var(--foreground);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  outline: none;
}
button:hover { background: var(--secondary); }
button:focus-visible { border-color: var(--ring); box-shadow: 0 0 0 3px color-mix(in oklch, var(--ring) 50%, transparent); }
`;

/** What the mark says, as words: the same words its parts show, for a screen reader and a test. */
export function indicatorWords(view: IndicatorView): {
  label: string;
  voice: string | null;
  button: string;
} {
  if (view.excluded)
    return {
      label: `Not recording ${view.site}`,
      voice: null,
      button: "Record it",
    };
  return {
    label: "OpenBot is recording this tab",
    voice: view.narrating === true ? "Listening to you" : null,
    button: `Don't record ${view.site}`,
  };
}

export function showIndicator(options: {
  view: IndicatorView;
  /** The person's click: false leaves the site out of every recording, true records it again. */
  choose(recorded: boolean): void;
  isTrusted?: (event: Event) => boolean;
  /** What the page shows at a point, under the mark: the browser's own hit test unless a test gives one. */
  under?: (x: number, y: number) => Element | null;
  timers?: Timers;
}): {
  host: HTMLElement;
  /** Inside the mark, for this content script and its tests alone: the page sees no shadow root. */
  root: ShadowRoot;
  update(view: IndicatorView): void;
  remove(): void;
} {
  const trusted = options.isTrusted ?? ((event: Event) => event.isTrusted);
  const host = document.createElement(INDICATOR_TAG);
  host.setAttribute("data-copilotkit-ignore", "");
  const root = host.attachShadow({
    mode: import.meta.env.RECORDER_VARIANT === "e2e" ? "open" : "closed",
  });
  const style = document.createElement("style");
  style.textContent = STYLE;

  const mark = document.createElement("div");
  mark.className = "mark";
  mark.setAttribute("role", "status");
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "label";
  const voice = document.createElement("span");
  voice.className = "voice";
  const button = document.createElement("button");
  button.type = "button";
  mark.append(dot, label, voice, button);

  let current = options.view;
  button.addEventListener("click", (event) => {
    if (!trusted(event)) return;
    options.choose(current.excluded);
  });

  const update = (view: IndicatorView) => {
    current = view;
    const words = indicatorWords(view);
    mark.toggleAttribute("data-excluded", view.excluded);
    label.textContent = words.label;
    voice.textContent = words.voice ? `· ${words.voice}` : "";
    voice.hidden = words.voice === null;
    button.textContent = words.button;
  };
  update(options.view);

  root.append(style, mark);
  document.documentElement.append(host);

  /*
   * Put back when the page takes it away (the header says how). `moves` counts this look's moves to the end of the
   * root element, so two scripts that each want to be last stop trading places after a few.
   */
  let moves = 0;
  let removed = false;
  const keep = () => {
    if (removed) return;
    for (const attribute of ["hidden", "inert"])
      if (host.hasAttribute(attribute)) host.removeAttribute(attribute);
    const top = document.documentElement;
    if (!top) return;
    if (host.parentNode === top && top.lastElementChild === host) return;
    if (host.isConnected && moves >= MOVES_PER_LOOK) return;
    moves += 1;
    top.append(host);
  };
  const watch = new MutationObserver(keep);
  const observe = () => {
    watch.disconnect();
    // The document's own children too: a page that replaces its root element takes the mark with it.
    watch.observe(document, { childList: true });
    if (document.documentElement)
      watch.observe(document.documentElement, { childList: true });
    watch.observe(host, {
      attributes: true,
      attributeFilter: ["hidden", "inert"],
    });
  };
  observe();

  // Where it hangs, looked at again as the page changes (the header says why). A page with no hit test (none in a
  // browser the Recorder runs in) shows it at its first spot.
  const under =
    options.under ??
    ((x: number, y: number) =>
      typeof document.elementsFromPoint === "function"
        ? (document
            .elementsFromPoint(x, y)
            .find(
              (element) =>
                element !== host &&
                element !== document.documentElement &&
                element !== document.body,
            ) ?? null)
        : null);
  const timers: Timers = options.timers ?? {
    set: (fn, ms) => setInterval(fn, ms),
    clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  let spot: MarkSpot | undefined;
  let held = 0;
  const place = () => {
    moves = 0;
    keep();
    // A replaced root element is a new one to watch.
    if (host.parentNode !== null) observe();
    if (held > 0) return;
    const rect = mark.getBoundingClientRect();
    const size = { width: rect.width, height: rect.height };
    const page = {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
    };
    spot = chooseSpot(
      (candidate) => coveredIn(spotBox(candidate, size, page), under),
      spot,
    );
    const box = spotBox(spot, size, page);
    // On the mark inside, where the page cannot reach: the host stays at the page's top left, as its own rule says.
    mark.style.left = `${box.left}px`;
    mark.style.top = `${box.top}px`;
    mark.dataset.edge = spot.edge;
  };
  // Never away from under the person's pointer, nor while the button has the keyboard.
  const hold = () => {
    held += 1;
  };
  const release = () => {
    held = Math.max(0, held - 1);
  };
  host.addEventListener("pointerenter", hold);
  host.addEventListener("pointerleave", release);
  root.addEventListener("focusin", hold);
  root.addEventListener("focusout", release);
  place();
  const looking = timers.set(place, LOOK_MS);
  window.addEventListener("resize", place);

  return {
    host,
    root,
    update: (view) => {
      update(view);
      // Its words changed, and with them its width.
      place();
    },
    remove: () => {
      removed = true;
      watch.disconnect();
      timers.clear(looking);
      window.removeEventListener("resize", place);
      host.remove();
    },
  };
}

import type { Page } from "playwright";
import { parseAriaSnapshot } from "./aria-snapshot";
import {
  type BrowserAction,
  type BrowserComputer,
  type BrowserManager,
  type BrowserSnapshot,
  type HumanAction,
  StaleSnapshotError,
} from "./browser";
import { createProfiles, VIEWPORT } from "./profiles";
import { startScreencast } from "./screencast";

const TEXT_EXTRACT_LIMIT = 6000;
const FOLLOW_INTERVAL_MS = 1_000;

async function readablePageText(target: Page) {
  const raw = await target.evaluate(() => {
    const clone = document.body?.cloneNode(true) as HTMLElement | undefined;
    if (!clone) return "";
    for (const node of clone.querySelectorAll("script, style, noscript, svg")) {
      node.remove();
    }
    return clone.innerText ?? "";
  });
  const collapsed = raw.replace(/\n{3,}/g, "\n\n").trim();
  return {
    text: collapsed.slice(0, TEXT_EXTRACT_LIMIT),
    truncated: collapsed.length > TEXT_EXTRACT_LIMIT,
  };
}

function at(body: Record<string, unknown>): { x: number; y: number } {
  const x = typeof body.x === "number" ? body.x : Number.NaN;
  const y = typeof body.y === "number" ? body.y : Number.NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("A click needs an x and a y inside the page.");
  }
  return {
    x: Math.min(Math.max(x, 0), VIEWPORT.width - 1),
    y: Math.min(Math.max(y, 0), VIEWPORT.height - 1),
  };
}

export function createPlaywrightBrowserManager(
  root: string,
  options: { actionTimeoutMs: number; navigationTimeoutMs: number },
): BrowserManager {
  const profiles = createProfiles(root);
  const computers = new Map<string, BrowserComputer>();

  const build = (botId: string): BrowserComputer => {
    let snapshotId = 0;
    const currentPage = (): Promise<Page> => profiles.page(botId);

    const locateRef = (
      target: Page,
      ref: string,
      expectedSnapshotId: number | undefined,
    ) => {
      if (
        expectedSnapshotId !== undefined &&
        expectedSnapshotId !== snapshotId
      ) {
        throw new StaleSnapshotError(
          `That list of elements is out of date: it was taken for snapshot ${expectedSnapshotId} and the page is now at ${snapshotId}. Take a new snapshot and use the refs from it.`,
        );
      }
      return target.locator(`aria-ref=${ref}`);
    };

    const resolveRef = async (
      target: Page,
      ref: string,
      expectedSnapshotId: number | undefined,
    ) => {
      const locator = locateRef(target, ref, expectedSnapshotId);
      if ((await locator.count()) === 0) {
        throw new StaleSnapshotError(
          `Nothing on this page has the ref ${ref}. Take a new snapshot and use the refs it returns.`,
        );
      }
      return locator;
    };

    return {
      async navigate(destination) {
        const target = await currentPage();
        await target.goto(destination, {
          waitUntil: "domcontentloaded",
          timeout: options.navigationTimeoutMs,
        });
        snapshotId += 1;
        const extract = await readablePageText(target);
        return {
          url: target.url(),
          title: await target.title(),
          ...extract,
        };
      },

      async read() {
        const target = await currentPage();
        return {
          url: target.url(),
          title: await target.title(),
          ...(await readablePageText(target)),
        };
      },

      async screenshot() {
        const target = await currentPage();
        const buffer = await target.screenshot({ type: "png" });
        const size = target.viewportSize() ?? VIEWPORT;
        return {
          base64: buffer.toString("base64"),
          width: size.width,
          height: size.height,
          capturedAt: new Date().toISOString(),
          url: target.url(),
        };
      },

      async snapshot(): Promise<BrowserSnapshot> {
        const target = await currentPage();
        snapshotId += 1;
        const yaml = await target.ariaSnapshot({ mode: "ai" });
        return {
          snapshotId,
          url: target.url(),
          title: await target.title(),
          ...parseAriaSnapshot(yaml),
        };
      },

      async click(ref, expected, signal): Promise<BrowserAction> {
        const target = await currentPage();
        await (await resolveRef(target, ref, expected)).click({
          timeout: options.actionTimeoutMs,
          ...(signal ? { signal } : {}),
        });
        return { action: "click", ref, url: target.url() };
      },

      async type(ref, text, submit, expected, signal): Promise<BrowserAction> {
        const target = await currentPage();
        const field = await resolveRef(target, ref, expected);
        const acting = {
          timeout: options.actionTimeoutMs,
          ...(signal ? { signal } : {}),
        };
        await field.fill(text, acting);
        if (submit) await field.press("Enter", acting);
        return {
          action: "type",
          ref,
          characters: text.length,
          submitted: submit,
          url: target.url(),
        };
      },

      async key(key, ref, expected, signal): Promise<BrowserAction> {
        const target = await currentPage();
        if (ref) {
          await (await resolveRef(target, ref, expected)).press(key, {
            timeout: options.actionTimeoutMs,
            ...(signal ? { signal } : {}),
          });
        } else {
          await target.keyboard.press(key);
        }
        return { action: "key", key, ref, url: target.url() };
      },

      async scroll(deltaY): Promise<BrowserAction> {
        const target = await currentPage();
        await target.mouse.wheel(0, deltaY);
        return { action: "scroll", deltaY, url: target.url() };
      },

      async enterSecret(ref, text) {
        const target = await currentPage();
        const field = locateRef(target, ref, undefined);
        await field.click({ timeout: options.actionTimeoutMs });
        await field.fill(text, { timeout: options.actionTimeoutMs });
        return { characters: text.length, url: target.url() };
      },

      async humanClick(x, y): Promise<HumanAction> {
        const target = await currentPage();
        const point = at({ x, y });
        await target.mouse.click(point.x, point.y);
        return { action: "human_click", url: target.url() };
      },

      async humanType(text): Promise<HumanAction> {
        const target = await currentPage();
        await target.keyboard.insertText(text);
        return {
          action: "human_type",
          characters: text.length,
          url: target.url(),
        };
      },

      async humanKey(key): Promise<HumanAction> {
        const target = await currentPage();
        await target.keyboard.press(key);
        return { action: "human_key", key, url: target.url() };
      },

      async humanScroll(deltaY): Promise<HumanAction> {
        const target = await currentPage();
        await target.mouse.wheel(0, deltaY);
        return { action: "human_scroll", deltaY, url: target.url() };
      },

      async startStream(onFrame) {
        let stopped = false;
        let attaching = false;
        let casting = await currentPage();
        let cast = await startScreencast(casting, onFrame);
        const follow = setInterval(() => {
          if (stopped || attaching) return;
          attaching = true;
          void (async () => {
            try {
              const target = await currentPage();
              if (target === casting) return;
              const replacement = await startScreencast(target, onFrame);
              if (stopped) {
                await replacement.stop().catch(() => undefined);
                return;
              }
              const previous = cast;
              casting = target;
              cast = replacement;
              await previous.stop().catch(() => undefined);
            } finally {
              attaching = false;
            }
          })().catch(() => undefined);
        }, FOLLOW_INTERVAL_MS);
        return {
          async stop() {
            if (stopped) return;
            stopped = true;
            clearInterval(follow);
            await cast.stop();
          },
          send(message) {
            return cast.send(message);
          },
        };
      },
    };
  };

  return {
    backend: "playwright",
    computer(botId) {
      const existing = computers.get(botId);
      if (existing) return existing;
      const created = build(botId);
      computers.set(botId, created);
      return created;
    },
    known: profiles.known,
    summary: profiles.summary,
    async stop(botId) {
      const stopped = await profiles.stop(botId);
      computers.delete(botId);
      return stopped;
    },
    async reset(botId) {
      await profiles.reset(botId);
      computers.delete(botId);
    },
    closeAll: profiles.closeAll,
  };
}

/**
 * Session cookies, kept across a restart of the computer.
 *
 * Chromium writes a cookie with an expiry into the profile and drops a cookie without one when it
 * exits, exactly as a desktop browser does. On a desktop that is a browser being closed. Here it is
 * a pod being deleted, which is what an idle computer being suspended, a node being drained and an
 * image being updated all are, so every site that signs a person in with a session cookie alone
 * asked the Bot to sign in again after each of them. A Bot's sign-ins are meant to persist between
 * tasks, and a suspended computer is meant to be hibernating rather than gone.
 *
 * So the session cookies are written to a file in the Bot's own profile directory, and put back
 * before the first navigation of the next launch. Only session cookies: the ones with an expiry are
 * already in the profile, and writing them twice would give two sources of truth for one cookie.
 *
 * WHERE IT LIVES IS THE ISOLATION AND THE RESET. The file is inside the Bot's profile directory, so
 * it is on the same volume as the rest of its logins, no other Bot's launch reads it, and a reset
 * that deletes the profile deletes it too. It is written 0600, the same protection the profile's
 * own Cookies database has on that volume.
 *
 * Imports Playwright's types only, so the rules here are testable without a browser installed.
 */

import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Cookie } from "playwright";

/** In the profile directory, beside the Cookies database Chromium keeps there itself. */
export const SESSION_COOKIES_FILE = "openbot-session-cookies.json";

/** How often a running browser's session cookies are checked and, when they changed, written. */
export const SESSION_COOKIE_SAVE_MS = 30_000;

/** Playwright reports a cookie with no expiry as `expires: -1`. */
export function isSessionCookie(cookie: Cookie): boolean {
  return cookie.expires === -1 || cookie.expires === undefined;
}

const keyOf = (cookie: Pick<Cookie, "name" | "domain" | "path">) =>
  `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;

/**
 * The saved session cookies that should go back into a browser that has just started.
 *
 * Never one the browser already holds: a cookie with the same name, domain and path came from the
 * profile, and the profile is the more recent of the two. Never one with an expiry that has passed,
 * which cannot come from this file's own writes but can come from a file written by hand.
 */
export function cookiesToRestore(
  saved: Cookie[],
  present: Cookie[],
  nowSeconds: number,
): Cookie[] {
  const held = new Set(present.map(keyOf));
  return saved.filter(
    (cookie) =>
      !held.has(keyOf(cookie)) &&
      (isSessionCookie(cookie) || cookie.expires > nowSeconds),
  );
}

/** What the file holds for a set of cookies, stable so an unchanged set compares equal. */
export function serialiseSessionCookies(cookies: Cookie[]): string {
  const session = cookies
    .filter(isSessionCookie)
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  return JSON.stringify({ version: 1, cookies: session });
}

function parseSaved(raw: string): Cookie[] {
  const parsed = JSON.parse(raw) as { cookies?: unknown };
  if (!Array.isArray(parsed.cookies)) return [];
  return parsed.cookies.filter(
    (cookie): cookie is Cookie =>
      typeof cookie === "object" &&
      cookie !== null &&
      typeof (cookie as Cookie).name === "string" &&
      typeof (cookie as Cookie).value === "string" &&
      typeof (cookie as Cookie).domain === "string" &&
      typeof (cookie as Cookie).path === "string",
  );
}

/** Counts and a reason only. A cookie's value is a credential and never reaches a log. */
function report(type: string, botId: string, detail: Record<string, unknown>) {
  console.info(JSON.stringify({ type, botId, ...detail }));
}

/**
 * Save and restore for one Bot's running browser.
 *
 * `save` is safe to call from a timer, a close and a shutdown at once: writes are chained, so two
 * never interleave into one file, and one that finds nothing changed writes nothing.
 */
export function sessionCookieKeeper(
  botId: string,
  profileDir: string,
  context: BrowserContext,
) {
  const file = join(profileDir, SESSION_COOKIES_FILE);
  let lastWritten: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;

  const writeNow = async (): Promise<void> => {
    let cookies: Cookie[];
    try {
      cookies = await context.cookies();
    } catch {
      // The browser has gone. What it last had is what the file already holds.
      return;
    }
    const body = serialiseSessionCookies(cookies);
    if (body === lastWritten) return;
    /*
     * Written beside the file and renamed over it, so a pod killed mid-write leaves the previous
     * file rather than half of one. Created 0600 and set 0600 again, because `mode` only applies to
     * a file that did not exist and a rename keeps the temporary file's permissions.
     */
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, body, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, file);
      lastWritten = body;
    } catch (error) {
      // A profile deleted by a reset lands here, and that is the reset working.
      await rm(temporary, { force: true }).catch(() => undefined);
      report("computer-session-cookies-not-saved", botId, {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const save = (): Promise<void> => {
    chain = chain.then(writeNow, writeNow);
    return chain;
  };

  return {
    /**
     * Put the saved session cookies back. Called before the first navigation, so the first request
     * a site sees from this launch already carries them.
     */
    async restore(): Promise<number> {
      let saved: Cookie[];
      try {
        saved = parseSaved(await readFile(file, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          report("computer-session-cookies-not-restored", botId, {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        return 0;
      }
      const restoring = cookiesToRestore(
        saved,
        await context.cookies(),
        Date.now() / 1000,
      );
      if (restoring.length > 0) await context.addCookies(restoring);
      // What the browser now holds is what the file says, so the first timer tick has nothing to do.
      lastWritten = serialiseSessionCookies(await context.cookies());
      if (restoring.length > 0) {
        report("computer-session-cookies-restored", botId, {
          count: restoring.length,
        });
      }
      return restoring.length;
    },

    save,

    /** Check every interval while the browser runs. The timer never holds the process open. */
    start(intervalMs = SESSION_COOKIE_SAVE_MS): void {
      if (timer) return;
      timer = setInterval(() => {
        void save();
      }, intervalMs);
      timer.unref?.();
    },

    /** Stop the timer and wait for any write in flight, so nothing is written after a reset's delete. */
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = undefined;
      await chain;
    },
  };
}

export type SessionCookieKeeper = ReturnType<typeof sessionCookieKeeper>;

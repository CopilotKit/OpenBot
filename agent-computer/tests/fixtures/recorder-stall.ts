/*
 * A computer's Recorder call made while the browser stops answering, for a few seconds or for good,
 * in a process of its own, so a test can tell an answer or a refusal from the process ending.
 *
 * Bundled Chromium with the fixture Recorder, as a hosted person's browser launches. The browser's
 * own process is stopped (SIGSTOP) at the moment the launcher hands the worker a message, and
 * resumed after the milliseconds given, or never: a browser too busy to take the message in time,
 * as a hosted computer's was while the Recorder recorded a burst of input. Prints the port it serves
 * on: `/state` makes the call and answers how it ended, `/alive` says the process is still up, and
 * `/stop` resumes the browser, closes it and ends the process.
 *
 *   bun tests/fixtures/recorder-stall.ts <profile dir> [stall ms]
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { type CDPSession, chromium } from "playwright";
import { recorderLaunchOptions } from "../../src/person-launch";
import { findRecorder } from "../../src/recorder";
import { createRecorderLauncher } from "../../src/recorder-launcher";

const dir = process.argv[2];
if (!dir) throw new Error("Pass a profile directory.");
/** How long the browser stays stopped; none means it never answers again. */
const STALL_MS = process.argv[3] ? Number(process.argv[3]) : undefined;

const found = await findRecorder(join(import.meta.dir, "recorder"));
if (!found.ok) throw new Error(found.error);
const context = await chromium.launchPersistentContext(dir, {
  channel: "chromium",
  ...recorderLaunchOptions(
    {
      recorderDir: found.recorder.dir,
      headless: true,
      sandbox: false,
      botArgs: [],
    },
    { width: 1280, height: 800 },
  ),
});

/** The browser's own process: the one with this profile on its command line and no `--type`. */
function browserProcess(): number {
  const listing = execFileSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });
  for (const line of listing.split("\n")) {
    const [pid, ...command] = line.trim().split(/\s+/);
    const text = command.join(" ");
    if (text.includes(`--user-data-dir=${dir}`) && !text.includes("--type="))
      return Number(pid);
  }
  throw new Error("The browser's process was not found.");
}

const browser = context.browser();
if (!browser) throw new Error("The browser did not start.");
const real = await browser.newBrowserCDPSession();
const pid = browserProcess();
let stalls = 0;
/** The browser-level session, with the browser stopped while it takes the first evaluation. */
const session = new Proxy(real, {
  get(target, property, receiver) {
    if (property !== "send") return Reflect.get(target, property, receiver);
    return (method: string, params?: { message?: string }) => {
      if (
        method === "Target.sendMessageToTarget" &&
        params?.message?.includes('"Runtime.evaluate"') &&
        stalls === 0
      ) {
        stalls += 1;
        process.kill(pid, "SIGSTOP");
        if (STALL_MS !== undefined)
          setTimeout(() => process.kill(pid, "SIGCONT"), STALL_MS);
      }
      return (target.send as (m: string, p?: object) => Promise<unknown>)(
        method,
        params,
      );
    };
  },
}) as CDPSession;

const launcher = createRecorderLauncher({
  session,
  context,
  recorderId: found.recorder.id,
});

/*
 * Served, as the computer serves the browser routes, rather than called at the top level: a Bun
 * process waiting at the top level on a promise stays up through an unhandled rejection, and one
 * serving requests, like the computer, exits on it.
 */
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/alive") return Response.json({ alive: true });
    if (pathname === "/state") {
      try {
        const state = await launcher.state();
        return Response.json({ outcome: `answered: ${state.phase}`, stalls });
      } catch (error) {
        return Response.json({
          outcome: `refused: ${error instanceof Error ? error.message : String(error)}`,
          stalls,
        });
      }
    }
    if (pathname === "/stop") {
      process.kill(pid, "SIGCONT");
      setTimeout(async () => {
        await context.close();
        server.stop(true);
        process.exit(0);
      }, 0);
      return Response.json({ stopping: true });
    }
    return new Response("Not found.", { status: 404 });
  },
});
console.log(JSON.stringify({ port: server.port }));

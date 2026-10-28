/**
 * A person's native browser: their installed Chrome or Edge, started by this process on a DevTools
 * pipe and attached with Playwright's `connectOverCDP({ noDefaults: true })`, rather than launched by
 * Playwright.
 *
 * WHY NOT PLAYWRIGHT'S LAUNCH. A browser Playwright launches gets focus emulation
 * (`Emulation.setFocusEmulationEnabled`) on every page it attaches to, opened then or later, so every
 * tab says it is visible and focused whether it is in front or not. That is right for a test browser,
 * where several pages are driven at once, and wrong for a person's own: in the fifth end-to-end run
 * two background tabs of the Desktop window reported `visible` and `hasFocus()` every second, so sites
 * behind the tab in front behaved as if they were in front, and OpenBot, which asks the pages which
 * one the window shows, could not tell and named the wrong tab as the one the person was on.
 *
 * It cannot be turned off from beside Playwright. The browser keeps the emulation per DevTools
 * session, and Playwright's own session for the page holds it: another session switching it off
 * leaves `hasFocus()` false but the tab still `visible`, because the browser counts the first session
 * as capturing the tab (`EmulationHandler::SetFocusEmulationEnabled` takes a capture handle per
 * session). Measured on Google Chrome 156 headless with Playwright 1.62.1.
 *
 * Playwright's answer for a person's everyday browser is `noDefaults` (1.60): no focus emulation, no
 * download interception and no media emulation for any page of the default context, "so attaching
 * to a user's daily-driver browser doesn't disturb its state". It attaches over a transport this
 * process supplies, so the browser is started here, on a DevTools pipe as Playwright's launch would
 * start it, and the pipe stays this process's alone: nothing else on the machine reaches the person's
 * signed-in browser, which a debugging port would let any local program do.
 * https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
 * https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/protocol/emulation_handler.cc
 */
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  type BrowserContext,
  type ConnectOverCDPTransport,
  chromium,
} from "playwright";

export type NativeLaunch = {
  /** The installed browser's own executable. */
  executable: string;
  /** Every switch it starts with: nothing is added under them. */
  args: string[];
  /** Its environment, when it differs from this process's. */
  env?: Record<string, string>;
};

/** How long the browser may take to start and show its first window: as long as Playwright's own launch waits. */
const LAUNCH_MS = 180_000;
/** How long a close may take before the browser is killed: a browser that will not quit must not hold a close open. */
const CLOSE_MS = 20_000;
/** How many of the browser's last lines of output a failed launch reports. */
const LOG_LINES = 20;
/**
 * The id this module's own `Browser.close` goes out with. Playwright numbers its commands up from 1 and
 * takes an answer to an id it did not send as an error, so the answer to this one is not passed on.
 */
const CLOSE_ID = -1;

/** The browsers this process started and has not seen exit, killed if it exits first, as Playwright kills its own. */
const running = new Set<() => void>();
process.on("exit", () => {
  for (const kill of running) kill();
});

type PipeTransport = ConnectOverCDPTransport & {
  /** The browser's own `Browser.close`, the one command this module sends itself. */
  sendClose(): void;
};

/**
 * The browser's DevTools pipe, read and written as Playwright's own pipe transport does: each message
 * is JSON ended by a NUL byte, written to the browser's fd 3 and read from its fd 4, and each one read
 * is handed on in a task of its own.
 * https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/devtools_pipe_handler.cc
 */
function pipeTransport(
  write: Writable,
  read: Readable,
  close: () => Promise<void>,
): PipeTransport {
  let closed = false;
  let pending: Buffer[] = [];
  let onclose: ((reason?: string) => void) | undefined;
  const transport: PipeTransport = {
    onmessage: undefined,
    get onclose() {
      return onclose;
    },
    set onclose(listener) {
      onclose = listener;
      // The browser went away before anybody listened: said at once rather than never.
      if (listener && closed) listener();
    },
    send(message) {
      if (closed) throw new Error("The browser's DevTools pipe has closed.");
      write.write(`${JSON.stringify(message)}\0`);
    },
    // Closing the transport closes the browser, which ends the pipe.
    close,
    sendClose() {
      if (!closed)
        write.write(
          `${JSON.stringify({ id: CLOSE_ID, method: "Browser.close" })}\0`,
        );
    },
  };
  read.on("data", (chunk: Buffer) => {
    let start = 0;
    for (
      let end = chunk.indexOf(0, start);
      end !== -1;
      end = chunk.indexOf(0, start)
    ) {
      pending.push(chunk.subarray(start, end));
      const text = Buffer.concat(pending).toString("utf8");
      pending = [];
      start = end + 1;
      setImmediate(() => {
        const message = JSON.parse(text) as { id?: number };
        if (message.id !== CLOSE_ID) transport.onmessage?.(message);
      });
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  });
  read.on("close", () => {
    closed = true;
    onclose?.();
  });
  // A pipe that breaks is the browser going away, which the read side reports as its close.
  read.on("error", () => undefined);
  write.on("error", () => undefined);
  return transport;
}

/**
 * Start the person's browser and attach to it. Resolves with its one context, which closes the
 * browser when it is closed, and ends when the browser does (the person quit it, or it crashed).
 *
 * A browser that exits before it can be reached says why in its own words, its exit code and its last
 * lines of output (another browser holding the profile already, say), as Playwright's launch does.
 */
export async function launchNativeBrowser(
  launch: NativeLaunch,
): Promise<BrowserContext> {
  const child = spawn(launch.executable, launch.args, {
    // Its own process group, as Playwright starts a browser, so a kill takes its helper processes too
    // and a Ctrl-C in this process's terminal does not reach it first.
    detached: process.platform !== "win32",
    env: launch.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  const output: string[] = [];
  for (const stream of [child.stdout, child.stderr])
    if (stream)
      createInterface({ input: stream }).on("line", (line) => {
        output.push(line);
        if (output.length > LOG_LINES) output.shift();
      });
  const exited = new Promise<string>((resolve) => {
    child.once("error", (error) =>
      resolve(`it could not start: ${error.message}`),
    );
    child.once("exit", (code, signal) =>
      resolve(
        signal ? `it was stopped by ${signal}` : `it exited with code ${code}`,
      ),
    );
  });

  let gone = false;
  const kill = () => {
    if (gone || child.pid === undefined) return;
    try {
      if (process.platform === "win32")
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      // It exited between the check and the kill.
    }
  };
  running.add(kill);
  void exited.then(() => {
    gone = true;
    running.delete(kill);
  });

  let closing: Promise<void> | undefined;
  /** Quit the browser the way its own Quit does, so its profile is written; killed if it will not. */
  const close = (): Promise<void> => {
    closing ??= (async () => {
      transport.sendClose();
      const quit = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), CLOSE_MS).unref();
        }),
      ]);
      if (!quit) kill();
      await exited;
    })();
    return closing;
  };
  const [, , , toBrowser, fromBrowser] = child.stdio;
  if (!toBrowser || !fromBrowser) {
    kill();
    throw new Error(
      `The browser at ${launch.executable} was started without its DevTools pipe.`,
    );
  }
  const transport = pipeTransport(
    toBrowser as Writable,
    fromBrowser as Readable,
    close,
  );

  /** A browser that went away before it was ready, said with what it wrote last. */
  const exitedFirst = exited.then((why): never => {
    const said = output.length ? `\n${output.join("\n")}` : "";
    throw new Error(
      `The browser at ${launch.executable} could not be reached: ${why}.${said}`,
    );
  });
  // Lost by every race the browser wins, and then nobody's to hear.
  exitedFirst.catch(() => undefined);
  try {
    const browser = await Promise.race([
      chromium.connectOverCDP(transport, {
        noDefaults: true,
        timeout: LAUNCH_MS,
      }),
      exitedFirst,
    ]);
    const context = browser.contexts()[0];
    if (!context) throw new Error("The browser has no default profile.");
    // Its first window, which the person's own startup setting fills (the new tab page, or the tabs
    // they had last time): Playwright's launch waits for it too.
    if (context.pages().length === 0)
      await Promise.race([
        context.waitForEvent("page", { timeout: LAUNCH_MS }),
        exitedFirst,
      ]);
    return context;
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

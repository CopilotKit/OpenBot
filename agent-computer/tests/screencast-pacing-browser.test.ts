import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { reservePort } from "../../tests/support/reserved-port";
import { startScreencast } from "../src/screencast";

/**
 * The live screen ends on the page as it is, against Chromium itself.
 *
 * Chrome keeps two screencast frames unacknowledged at most. A frame that changes while two are out is not sent, and
 * it is not sent later either: once the page is still there is nothing new to send. So a cast that held the ack back
 * while the viewer's connection was busy, which is how it was once paced, left the person looking at the page as it
 * was a moment before it stopped, with nothing to say so. Measured on Chromium 151 with acks held 500 ms: of five
 * colour changes 40 ms apart, the second and third arrived and the last never did. A click aimed at what the person
 * saw then lands on what the page has since become.
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/screencast-pacing-browser.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const TOKEN = "screencast-pacing-token";
const FINAL = [0, 0, 255] as const;

let browser: Browser;
/** A tab that reads a frame back as pixels, so a test can say which page a frame shows. */
let decoder: Page;

beforeAll(async () => {
  if (!asked) return;
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ channel: "chromium" });
  decoder = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
});

/** The colour at the centre of a frame. */
function centreOf(base64: string): Promise<number[]> {
  return decoder.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2d context.");
    context.drawImage(image, 0, 0);
    return [
      ...context.getImageData(image.width / 2, image.height / 2, 1, 1).data,
    ].slice(0, 3);
  }, base64);
}

/** Whether a decoded colour is `FINAL`, give or take what JPEG does to it. */
const isFinal = (colour: number[]) =>
  colour.every((value, i) => Math.abs(value - (FINAL[i] ?? 0)) < 24);

describe.skipIf(!asked)("a page that stops changing", () => {
  test("its last change reaches a viewer whose connection takes its time over each frame", async () => {
    const context = await browser.newContext({
      viewport: { width: 400, height: 300 },
    });
    const tab = await context.newPage();
    await tab.setContent(
      `<body style="margin:0;background:rgb(255,0,0)"></body>`,
    );
    const frames: string[] = [];
    // A viewer that is still receiving each frame for 400 ms after it is handed over: a slow connection.
    const cast = await startScreencast(
      tab,
      (frame) => {
        frames.push(frame.data);
        return Bun.sleep(400);
      },
      { maxWidth: 400, maxHeight: 300 },
    );
    try {
      await Bun.sleep(500);
      for (const colour of [
        "0,255,0",
        "255,255,0",
        "0,255,255",
        "255,0,255",
        FINAL.join(","),
      ]) {
        await tab.evaluate((rgb) => {
          document.body.style.background = `rgb(${rgb})`;
        }, colour);
        await Bun.sleep(40);
      }
      // Long after every held frame would have been let go.
      await Bun.sleep(3_000);
      const last = frames.at(-1);
      expect(last).toBeDefined();
      expect(await centreOf(last ?? "")).toSatisfy(isFinal);
    } finally {
      await cast.stop();
      await context.close();
    }
  }, 30_000);

  test("on a slow link, the screen settles on the page as it is once it stops moving", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-pacing-"));
    // Animates for three seconds, then stops on a solid colour.
    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          `<style>body{margin:0}#b{width:100vw;height:100vh;background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);animation:s .5s linear infinite}@keyframes s{to{filter:hue-rotate(360deg)}}</style><div id=b></div>
<script>setTimeout(()=>{const b=document.getElementById('b');b.style.animation='none';b.style.filter='none';b.style.background='rgb(${FINAL.join(",")})'},3000)</script>`,
          { headers: { "content-type": "text/html" } },
        ),
    });
    const port = await reservePort();
    const child = Bun.spawn([process.execPath, "src/index.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        COMPUTER_TOKEN: TOKEN,
        PORT: String(port),
        COMPUTER_BROWSER_BACKEND: "managed",
        COMPUTER_BROWSER_MODE: "headless",
        // A page on this machine, which the default policy refuses.
        EGRESS_POLICY_REQUIRED: "0",
        PROFILES_DIR: join(root, "profiles"),
        WORKSPACE_DIR: join(root, "workspace"),
      },
      stdout: "ignore",
      stderr: "inherit",
    });
    let hop: Server | undefined;
    try {
      const base = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 15_000;
      while (
        !(await fetch(`${base}/health`)
          .then((response) => response.ok)
          .catch(() => false))
      ) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error("The computer did not start.");
        await Bun.sleep(50);
      }
      const navigated = await fetch(`${base}/navigate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-bot-id": "pacing",
          "x-openbot-computer-token": TOKEN,
        },
        body: JSON.stringify({ url: `http://127.0.0.1:${site.port}/` }),
      });
      expect(navigated.status).toBe(200);

      // A hop that carries 400 KB a second from the computer to the viewer, as a slow connection does.
      const RATE = 400 * 1024;
      hop = createServer((viewer: Socket) => {
        const computer = connect(port, "127.0.0.1");
        viewer.on("data", (data) => computer.write(data));
        computer.on("data", (chunk: Buffer) => {
          computer.pause();
          viewer.write(chunk);
          setTimeout(() => computer.resume(), (chunk.length / RATE) * 1000);
        });
        for (const [a, b] of [
          [viewer, computer],
          [computer, viewer],
        ] as const) {
          a.on("close", () => b.destroy());
          a.on("error", () => b.destroy());
        }
      });
      const hopPort = await reservePort();
      await new Promise<void>((resolve) =>
        hop?.listen(hopPort, "127.0.0.1", () => resolve()),
      );

      const frames: { at: number; data: string }[] = [];
      const socket = new WebSocket(
        `ws://127.0.0.1:${hopPort}/stream?bot=pacing&token=${TOKEN}`,
      );
      socket.addEventListener("message", (event) => {
        const text = String(event.data);
        if (!text.startsWith('{"type":"frame"')) return;
        frames.push({
          at: performance.now(),
          data: (JSON.parse(text) as { data: string }).data,
        });
      });
      // Until nothing has arrived for three seconds: the screen has settled on whatever it is going to show.
      const settleBy = performance.now() + 45_000;
      await Bun.sleep(5_000);
      while (
        performance.now() < settleBy &&
        performance.now() - (frames.at(-1)?.at ?? 0) < 3_000
      )
        await Bun.sleep(250);
      socket.close();

      expect(frames.length).toBeGreaterThan(5);
      expect(await centreOf(frames.at(-1)?.data ?? "")).toSatisfy(isFinal);
    } finally {
      hop?.close();
      child.kill();
      await child.exited;
      site.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});

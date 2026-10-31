import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A Recorder call the browser does not answer costs a refusal, never the computer.
 *
 * A hosted computer exited on `RecorderUnavailableError: The Recorder did not answer in time.` while
 * the Recorder recorded a burst of input: the launcher armed its timer before handing the worker its
 * message and raced it only after, so a browser slow to take the message fired the timer with
 * nothing listening, and Bun ends a serving process on an unhandled rejection. Every Bot's browser on
 * that computer went with it.
 *
 * In a process of its own (`fixtures/recorder-stall.ts`), serving the call as the computer serves
 * its routes, with bundled Chromium and the fixture Recorder. The browser's own process is stopped at
 * the moment the launcher hands the worker a message: for three seconds, longer than the two a
 * readiness check allows, and then for good.
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/recorder-unanswered.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";

type Stalled = {
  child: ReturnType<typeof Bun.spawn>;
  base: string;
  root: string;
};
const running: Stalled[] = [];

async function stalled(stallMs?: number): Promise<Stalled> {
  const root = await mkdtemp(join(tmpdir(), "openbot-recorder-stall-"));
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", "recorder-stall.ts"),
      join(root, "profile"),
      ...(stallMs === undefined ? [] : [String(stallMs)]),
    ],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let text = "";
  const deadline = Date.now() + 30_000;
  while (!text.includes("\n")) {
    if (Date.now() > deadline) throw new Error("The process did not start.");
    const { value, done } = await reader.read();
    if (done) throw new Error("The process ended before it served.");
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const { port } = JSON.parse(text.split("\n")[0] ?? "{}") as { port: number };
  const started = { child, base: `http://127.0.0.1:${port}`, root };
  running.push(started);
  return started;
}

/** What the call ended in, or that the process ended under it. */
async function call(stalledProcess: Stalled): Promise<string> {
  const { base, child } = stalledProcess;
  try {
    const answer = (await (await fetch(`${base}/state`)).json()) as {
      outcome: string;
    };
    return answer.outcome;
  } catch {
    await child.exited;
    const said = await new Response(child.stderr as ReadableStream).text();
    return `the process ended with ${child.exitCode}: ${said}`;
  }
}

afterEach(async () => {
  for (const { child, base, root } of running.splice(0)) {
    await fetch(`${base}/stop`).catch(() => undefined);
    await Promise.race([child.exited, Bun.sleep(10_000)]);
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

describe.skipIf(!asked)("a Recorder call the browser does not answer", () => {
  test("in time is answered once the browser takes it, and the process carries on", async () => {
    const computer = await stalled(3_000);
    expect(await call(computer)).toBe("answered: idle");
    expect(computer.child.exitCode).toBeNull();
    expect((await fetch(`${computer.base}/alive`)).ok).toBe(true);
  }, 60_000);

  test("at all is refused, and the process carries on", async () => {
    const computer = await stalled();
    expect(await call(computer)).toBe(
      "refused: The Recorder did not answer in time.",
    );
    expect(computer.child.exitCode).toBeNull();
    expect((await fetch(`${computer.base}/alive`)).ok).toBe(true);
  }, 60_000);
});

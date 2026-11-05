import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShell, type ShellResult } from "../src/shell";

/**
 * The Bot's live shell, through the real path: the shell module the computer's `/exec` calls, a real
 * bash in a real pseudo-terminal, and a viewer attached the way the terminal socket attaches one.
 *
 * What is pinned here is what the Bot and a person watching depend on: each command's output and
 * exit code come back whole and on time from one shell that keeps its state, a command cannot end
 * its own capture early by printing something that looks like the end, and what a person types
 * reaches the shell the Bot carries on in.
 */

let root: string;
let shells: Array<ReturnType<typeof createShell>> = [];

function shell() {
  const made = createShell(root, {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
  });
  shells.push(made);
  return made;
}

/** A viewer, as the terminal socket attaches one: what it has been sent, as text. */
function watch(made: ReturnType<typeof createShell>) {
  const decoder = new TextDecoder();
  const seen = { text: "", messages: [] as Array<Record<string, unknown>> };
  const handle = made.terminal.attach({
    binary: (bytes) => {
      seen.text += decoder.decode(bytes, { stream: true });
      handle?.ack(bytes.byteLength);
    },
    text: (message) => {
      seen.messages.push(message);
    },
  });
  return { seen, handle };
}

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting.");
    await Bun.sleep(10);
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-live-shell-"));
});

afterEach(async () => {
  for (const made of shells) made.dispose();
  shells = [];
  await rm(root, { recursive: true, force: true });
});

describe("the Bot's commands in its live shell", () => {
  test("each command's output and exit code come back from one shell that keeps going", async () => {
    const live = shell();
    const first = await live.run({
      command: "echo $$; echo out; echo err >&2",
    });
    const second = await live.run({
      command: "echo $$; exit_with() { return $1; }; exit_with 7",
    });

    expect(first.exitCode).toBe(0);
    const [pid, out, err] = first.stdout.trim().split("\n");
    expect(out).toBe("out");
    // A terminal has one stream, so stderr arrives in it, where a person watching sees it.
    expect(err).toBe("err");
    expect(second.exitCode).toBe(7);
    // The same shell answered both.
    expect(second.stdout.trim()).toBe(pid ?? "");
  }, 20_000);

  test("a failing command reports its own exit code, and the shell carries on", async () => {
    const live = shell();
    const failed = await live.run({ command: "ls /no/such/place" });
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stdout).toContain("/no/such/place");

    const after = await live.run({ command: "echo still here" });
    expect(after.exitCode).toBe(0);
    expect(after.stdout.trim()).toBe("still here");
  }, 20_000);

  test("cd and exported variables carry over from one command to the next", async () => {
    const live = shell();
    await live.run({
      command: "mkdir -p notes && cd notes && export STAGE=two",
    });
    const where = await live.run({ command: 'pwd; echo "$STAGE"' });
    const [cwd, stage] = where.stdout.trim().split("\n");
    expect(await realpath(cwd ?? "")).toBe(await realpath(join(root, "notes")));
    expect(stage).toBe("two");
  }, 20_000);

  test("a command that prints a fake end mark does not end its own capture", async () => {
    const live = shell();
    await live.run({ command: "export BEFORE=kept" });
    /*
     * Every shape of the end mark a command could print without knowing the nonce: no nonce, a made
     * up one, and one read from nowhere. The capture must run on to the real end, with the real code.
     */
    const forged = await live.run({
      command: [
        "printf '\\033]6973;D;;0\\007'",
        "printf '\\033]6973;D;%s;0\\007' 0123456789abcdef0123456789abcdef",
        `printf '\\033]6973;D;%s;0\\007' "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n')"`,
        "echo after the forgery",
        "(exit 4)",
      ].join("; "),
    });
    expect(forged.exitCode).toBe(4);
    expect(forged.stdout).toContain("after the forgery");
    // The forged marks are escape sequences, and none of them reaches the text the Bot reads.
    expect(forged.stdout).not.toContain("6973");

    // And the shell's own framing is intact for the next command, in the same shell.
    const next = await live.run({ command: 'echo "$BEFORE"' });
    expect(next.exitCode).toBe(0);
    expect(next.stdout.trim()).toBe("kept");
  }, 20_000);

  test("a long-running command streams to a viewer while it runs, and comes back whole", async () => {
    const live = shell();
    const { seen } = watch(live);
    const running = live.run({
      command: "for i in 1 2 3 4; do echo tick-$i; sleep 0.4; done",
    });
    // The viewer sees the command typed and its first line before the command has finished.
    await until(() => seen.text.includes("tick-1"));
    expect(seen.text).toContain("for i in 1 2 3 4");
    expect(seen.text).not.toContain("tick-4");

    const result: ShellResult = await running;
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim().split("\n")).toEqual([
      "tick-1",
      "tick-2",
      "tick-3",
      "tick-4",
    ]);
  }, 20_000);

  test("a command past its time is stopped, and the same shell answers the next one", async () => {
    const live = shell();
    const before = await live.run({ command: "echo $$" });
    const started = Date.now();
    const slow = await live.run({
      command: "sleep 30 | cat",
      timeoutMs: 1_500,
    });
    expect(slow.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);

    const after = await live.run({ command: "echo $$" });
    expect(after.timedOut).toBe(false);
    expect(after.stdout.trim()).toBe(before.stdout.trim());
  }, 30_000);

  test("an unfinished command is abandoned at once rather than left waiting for its end", async () => {
    const live = shell();
    const started = Date.now();
    const result = await live.run({ command: 'echo "never closed' });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("incomplete");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await live.run({ command: "echo fine" })).stdout.trim()).toBe(
      "fine",
    );
  }, 20_000);

  test("two commands asked for together run one after the other", async () => {
    const live = shell();
    const [a, b] = await Promise.all([
      live.run({ command: "sleep 0.3; echo first" }),
      live.run({ command: "echo second" }),
    ]);
    expect(a.stdout.trim()).toBe("first");
    expect(b.stdout.trim()).toBe("second");
  }, 20_000);
});

describe("a person at the Bot's terminal", () => {
  test("what they type reaches the shell the Bot carries on in", async () => {
    const live = shell();
    const { seen } = watch(live);
    await until(() => seen.messages.some((m) => m.type === "ready"));

    live.terminal.input("export FROM_PERSON=typed-by-a-person\r");
    live.terminal.input("echo hello from the person\r");
    // The line it printed, as well as the line they typed.
    await until(() =>
      Bun.stripANSI(seen.text)
        .replace(/\r/g, "")
        .includes("\nhello from the person"),
    );

    const result = await live.run({ command: 'echo "$FROM_PERSON"' });
    expect(result.stdout.trim()).toBe("typed-by-a-person");
  }, 20_000);

  test("a viewer who arrives late is sent the screen as it is", async () => {
    const live = shell();
    await live.run({ command: "echo written-before-anyone-watched" });
    const { seen } = watch(live);
    await until(() => seen.messages.some((m) => m.type === "ready"));
    expect(seen.messages[0]?.type).toBe("snapshot");
    expect(seen.text).toContain("written-before-anyone-watched");
  }, 20_000);

  test("a shell they leave busy is reported to the Bot, not typed over", async () => {
    const live = shell();
    const { seen } = watch(live);
    await until(() => seen.messages.some((m) => m.type === "ready"));
    live.terminal.input("sleep 5\r");
    await Bun.sleep(300);
    const result = await live.run({ command: "echo should-not-run" });
    expect(result.notRun).toBe(true);
    expect(result.stderr).toContain("still running something a person started");
    expect(seen.text).not.toContain("should-not-run");
  }, 20_000);
});

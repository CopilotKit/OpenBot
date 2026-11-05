import { expect, test } from "bun:test";
import { reservePort } from "./reserved-port";

/**
 * A port chosen for a server a test is about to start stays the test's until that server takes it.
 *
 * Chosen the old way (listen on 0, read the port, close), it went straight back in the pool: on
 * Linux, 40,000 listeners on port 0 were handed one of 20 ports chosen that way 121 times. The
 * computer binds two listeners on port 0 just before its own port, and on main's CI it died with
 * "Failed to start server. Is port 38953 in use?". macOS hands ports out in order rather than at
 * random, so this can only catch that regression on Linux, which is where CI runs.
 */
test("a reserved port is never given to a listener on port 0, and a server in another process binds it by number", async () => {
  const reserved = new Set<number>();
  for (let index = 0; index < 20; index++) reserved.add(await reservePort());
  expect(reserved.size).toBe(20);

  const given: number[] = [];
  for (let index = 0; index < 5_000; index++) {
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const { port } = listener;
    void listener.stop(true);
    if (port !== undefined && reserved.has(port)) given.push(port);
  }
  expect(given).toEqual([]);

  // As the computer, the app and the Bots are started: their own process, told the port by number.
  const [port] = reserved;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("mine") }); console.log("listening");`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("listening");
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe(
      "mine",
    );
  } finally {
    child.kill();
    await child.exited;
  }
});

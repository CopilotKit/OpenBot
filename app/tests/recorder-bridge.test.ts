import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { detectRecorder, sendConnectCode } from "@/lib/recorder/bridge";

type Reply = (answer: unknown) => void;
type Handler = (id: string, message: unknown, reply: Reply) => void;

const globals = globalThis as { chrome?: unknown };
let savedChrome: unknown;
let hadChrome = false;

function installChrome(handler: Handler) {
  const runtime: { lastError?: unknown; sendMessage: Handler } = {
    sendMessage: (id, message, reply) => handler(id, message, reply),
  };
  globals.chrome = { runtime };
  return runtime;
}

beforeEach(() => {
  hadChrome = "chrome" in globals;
  savedChrome = globals.chrome;
});

afterEach(() => {
  if (hadChrome) globals.chrome = savedChrome;
  else delete globals.chrome;
});

describe("detectRecorder", () => {
  test("the first id that answers wins and its installId is returned", async () => {
    const asked: unknown[] = [];
    installChrome((id, message, reply) => {
      asked.push(message);
      if (id === "bbb")
        setTimeout(
          () =>
            reply({ ok: true, version: "1.2.3", installId: "a".repeat(32) }),
          5,
        );
      if (id === "ccc") setTimeout(() => reply({ ok: true, version: "9" }), 40);
    });
    const found = await detectRecorder(["aaa", "bbb", "ccc"], 200);
    expect(found).toEqual({
      id: "bbb",
      version: "1.2.3",
      installId: "a".repeat(32),
    });
    expect(asked[0]).toEqual({ type: "openbot.ping" });
  });

  test("an answer of only ok: true is detected with no installId", async () => {
    installChrome((_id, _message, reply) => reply({ ok: true }));
    const found = await detectRecorder(["aaa"], 200);
    expect(found).toStrictEqual({ id: "aaa" });
  });

  test("an id that fails with lastError is skipped for one that answers", async () => {
    const runtime = installChrome((id, _message, reply) => {
      if (id === "aaa") {
        runtime.lastError = { message: "Could not establish connection" };
        reply(undefined);
        runtime.lastError = undefined;
      } else setTimeout(() => reply({ ok: true }), 5);
    });
    expect(await detectRecorder(["aaa", "bbb"], 200)).toEqual({ id: "bbb" });
  });

  test("no answer within the timeout resolves null", async () => {
    installChrome(() => {});
    expect(await detectRecorder(["aaa"], 20)).toBeNull();
  });

  test("every id failing resolves null", async () => {
    const runtime = installChrome((_id, _message, reply) => {
      runtime.lastError = { message: "no" };
      reply(undefined);
      runtime.lastError = undefined;
    });
    expect(await detectRecorder(["aaa", "bbb"], 200)).toBeNull();
  });

  test("no ids resolves null", async () => {
    installChrome(() => {});
    expect(await detectRecorder([], 20)).toBeNull();
  });

  test("chrome absent (Firefox, Safari) resolves null without throwing", async () => {
    delete globals.chrome;
    expect(await detectRecorder(["aaa"], 20)).toBeNull();
  });

  test("chrome without runtime.sendMessage resolves null", async () => {
    globals.chrome = { runtime: {} };
    expect(await detectRecorder(["aaa"], 20)).toBeNull();
  });

  test("a sendMessage that throws counts as no answer", async () => {
    installChrome(() => {
      throw new Error("bad id");
    });
    expect(await detectRecorder(["aaa"], 20)).toBeNull();
  });
});

describe("sendConnectCode", () => {
  test("sends openbot.connect to the id and returns the answer's installId", async () => {
    let sent: { id: string; message: unknown } | undefined;
    installChrome((id, message, reply) => {
      sent = { id, message };
      reply({
        ok: true,
        version: "1",
        installId: "b".repeat(32),
        awaitingConfirmation: true,
      });
    });
    const answer = await sendConnectCode("aaa", "obc_x");
    expect(sent).toEqual({
      id: "aaa",
      message: { type: "openbot.connect", code: "obc_x" },
    });
    expect(answer).toEqual({
      ok: true,
      installId: "b".repeat(32),
      awaitingConfirmation: true,
    });
  });

  test("a refusal comes back as its error code", async () => {
    installChrome((_id, _message, reply) =>
      reply({ ok: false, error: "pinned-elsewhere" }),
    );
    expect(await sendConnectCode("aaa", "obc_x")).toEqual({
      ok: false,
      error: "pinned-elsewhere",
    });
  });

  test("a throttled refusal carries how long until the Recorder takes a connect again", async () => {
    installChrome((_id, _message, reply) =>
      reply({ ok: false, error: "throttled", retryAfterMs: 420_000 }),
    );
    expect(await sendConnectCode("aaa", "obc_x")).toEqual({
      ok: false,
      error: "throttled",
      retryAfterMs: 420_000,
    });
  });

  test("lastError, no answer or no chrome is a refusal, not a throw", async () => {
    const runtime = installChrome((_id, _message, reply) => {
      runtime.lastError = { message: "gone" };
      reply(undefined);
      runtime.lastError = undefined;
    });
    expect((await sendConnectCode("aaa", "obc_x")).ok).toBe(false);
    delete globals.chrome;
    expect((await sendConnectCode("aaa", "obc_x")).ok).toBe(false);
  });
});

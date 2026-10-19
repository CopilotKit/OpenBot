import { describe, expect, test } from "bun:test";
import { prepareRecording } from "../src/pages/popup/prepare";

function doubles(opts: {
  host: boolean;
  microphone?: PermissionState | null;
  asked?: boolean;
}) {
  const opened: string[] = [];
  const remembered: boolean[] = [];
  let asked = opts.asked ?? false;
  return {
    opened,
    remembered,
    deps: {
      hasHostPermission: async () => opts.host,
      microphoneState: async () =>
        opts.microphone === undefined ? "granted" : opts.microphone,
      microphoneAsked: async () => asked,
      rememberMicrophoneAsked: async () => {
        asked = true;
        remembered.push(true);
      },
      openTab: async (url: string) => {
        opened.push(url);
      },
    },
  };
}

describe("prepareRecording", () => {
  test("without website access it opens access.html and reports permission", async () => {
    const { deps, opened } = doubles({ host: false });
    expect(await prepareRecording(deps)).toEqual({
      ok: false,
      reason: "permission",
    });
    expect(opened).toEqual(["access.html"]);
  });

  test("with website access it is ready and opens nothing", async () => {
    const { deps, opened } = doubles({ host: true });
    expect(await prepareRecording(deps)).toEqual({ ok: true });
    expect(opened).toEqual([]);
  });

  test("the first Record while Chrome has never been asked opens the microphone page once", async () => {
    const d = doubles({ host: true, microphone: "prompt" });
    expect(await prepareRecording(d.deps)).toEqual({
      ok: false,
      reason: "microphone",
    });
    expect(d.opened).toEqual(["microphone.html"]);
    expect(d.remembered).toEqual([true]);
    // Pressed again without answering: Record goes ahead, and the Voice row says the microphone is not allowed.
    expect(await prepareRecording(d.deps)).toEqual({ ok: true });
    expect(d.opened).toEqual(["microphone.html"]);
  });

  test("a microphone Chrome allowed, refused or cannot report opens nothing", async () => {
    for (const microphone of ["granted", "denied", null] as const) {
      const d = doubles({ host: true, microphone });
      expect(await prepareRecording(d.deps)).toEqual({ ok: true });
      expect(d.opened).toEqual([]);
    }
  });

  test("website access is asked for before the microphone", async () => {
    const d = doubles({ host: false, microphone: "prompt" });
    expect(await prepareRecording(d.deps)).toEqual({
      ok: false,
      reason: "permission",
    });
    expect(d.opened).toEqual(["access.html"]);
    expect(d.remembered).toEqual([]);
  });

  test("never requests a permission from the popup", async () => {
    const g = globalThis as { chrome?: unknown };
    const saved = g.chrome;
    let requested = 0;
    g.chrome = {
      permissions: {
        request: () => {
          requested++;
        },
      },
    };
    try {
      await prepareRecording(doubles({ host: false }).deps);
      await prepareRecording(doubles({ host: true }).deps);
    } finally {
      g.chrome = saved;
    }
    expect(requested).toBe(0);
  });
});

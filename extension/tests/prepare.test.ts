import { describe, expect, test } from "bun:test";
import { prepareRecording } from "../src/pages/popup/prepare";

function doubles(opts: {
  host: boolean;
  microphone?: "granted" | "prompt" | "denied";
}) {
  const opened: string[] = [];
  return {
    opened,
    deps: {
      hasHostPermission: async () => opts.host,
      microphoneState: async () => opts.microphone ?? "denied",
      openTab: async (url: string) => {
        opened.push(url);
      },
    },
  };
}

describe("prepareRecording", () => {
  test("without website access it opens access.html and reports permission", async () => {
    const { deps, opened } = doubles({ host: false, microphone: "granted" });
    expect(await prepareRecording(deps)).toEqual({
      ok: false,
      reason: "permission",
    });
    expect(opened).toEqual(["access.html"]);
  });

  test("with website access and a granted microphone it is ready with the microphone", async () => {
    const { deps, opened } = doubles({ host: true, microphone: "granted" });
    expect(await prepareRecording(deps)).toEqual({
      ok: true,
      microphone: true,
    });
    expect(opened).toEqual([]);
  });

  test.each(["prompt", "denied"] as const)(
    "a %s microphone is ready without the microphone",
    async (microphone) => {
      const { deps } = doubles({ host: true, microphone });
      expect(await prepareRecording(deps)).toEqual({
        ok: true,
        microphone: false,
      });
    },
  );

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

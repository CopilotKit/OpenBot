import { describe, expect, test } from "bun:test";
import { prepareRecording } from "../src/pages/popup/prepare";

function doubles(opts: { host: boolean }) {
  const opened: string[] = [];
  return {
    opened,
    deps: {
      hasHostPermission: async () => opts.host,
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

import { describe, expect, test } from "bun:test";
import { StaleSnapshotError } from "../src/browser";
import { createCuaBrowserManager, type CuaDriver } from "../src/cua-browser";

type Call = { name: string; args: Record<string, unknown> };

function response(
  data: Record<string, unknown> = {},
  images: { mimeType: string; dataBase64: string }[] = [],
) {
  return {
    text: "ok",
    images,
    structuredJson: JSON.stringify(data),
    isError: false,
    rawJson: "{}",
  };
}

function refusal(code: string, text: string) {
  return {
    text,
    images: [],
    structuredJson: JSON.stringify({ refusal: { code } }),
    isError: true,
    errorCode: code,
    rawJson: "{}",
  };
}

function fixture(
  override?: (
    call: Call,
  ) => ReturnType<typeof response> | ReturnType<typeof refusal> | undefined,
) {
  const calls: Call[] = [];
  let shutdown = false;
  let currentUrl = "about:blank";
  let currentTitle = "";
  const driver: CuaDriver = {
    async callTool(name, argumentsJson) {
      const args = JSON.parse(argumentsJson) as Record<string, unknown>;
      calls.push({ name, args });
      const overridden = override?.({ name, args });
      if (overridden) return overridden;
      if (name === "browser_navigate") {
        currentUrl = new URL(String(args.url)).href;
        currentTitle = "Example Domain";
        return response();
      }
      if (name === "browser_prepare") return response({ prepared_pid: 222 });
      if (name === "list_windows") {
        return response({ windows: [{ window_id: 333, z_index: 1 }] });
      }
      if (name === "get_browser_state" && "pid" in args) {
        return response({
          binding_quality: "exact",
          mutation_allowed: true,
          target_id: "target-1",
          tabs: [
            {
              tab_id: "tab-1",
              active: true,
              url: currentUrl,
              title: currentTitle,
            },
          ],
        });
      }
      if (name === "get_browser_state") {
        currentUrl = "https://example.com/";
        currentTitle = "Example Domain";
        return response({
          page: { url: currentUrl, title: currentTitle },
          outline: "Example Domain\nThis domain is for examples.",
          snapshot: { complete: true },
          refs: [
            {
              ref: "p1:1",
              role: "link",
              name: "More information",
              actions: ["click"],
              states: {},
            },
            {
              ref: "p1:2",
              role: "checkbox",
              name: "Remember me",
              value: "yes",
              actions: ["click"],
              states: { disabled: false },
            },
            {
              ref: "p1:3",
              role: "heading",
              name: "Example Domain",
              actions: [],
              states: {},
            },
          ],
        });
      }
      if (name === "get_window_state") {
        return response({ screenshot_width: 900, screenshot_height: 640 }, [
          { mimeType: "image/png", dataBase64: "cG5n" },
        ]);
      }
      return response();
    },
    async shutdown() {
      shutdown = true;
    },
  };
  const manager = createCuaBrowserManager(
    "/tmp/openbot-cua-test",
    driver,
    "/chrome",
    {
      async seedPid() {
        return { pid: 111, close: async () => undefined };
      },
      sleep: async () => undefined,
    },
  );
  return { calls, manager, shutdown: () => shutdown };
}

describe("Cua Driver browser backend", () => {
  test("prepares a durable isolated profile and maps semantic refs", async () => {
    const { calls, manager } = fixture();
    const computer = manager.computer("sales-bot");

    const page = await computer.navigate("https://example.com");
    expect(page).toMatchObject({
      url: "https://example.com/",
      title: "Example Domain",
      truncated: false,
    });
    const snapshot = await computer.snapshot();
    expect(snapshot.elements).toEqual([
      {
        ref: "p1:1",
        role: "link",
        name: "More information",
      },
      {
        ref: "p1:2",
        role: "checkbox",
        name: "Remember me",
        value: "yes",
        disabled: false,
      },
    ]);

    expect(
      calls.find((call) => call.name === "browser_prepare")?.args,
    ).toMatchObject({
      pid: 111,
      allow_launch: true,
      profile: { mode: "isolated_named", name: "sales-bot" },
      session: "openbot-sales-bot",
    });
  });

  test("uses current refs and an explicit synthetic background click", async () => {
    const { calls, manager } = fixture();
    const computer = manager.computer("sales-bot");
    const snapshot = await computer.snapshot();

    await expect(
      computer.click("p1:1", snapshot.snapshotId),
    ).resolves.toMatchObject({
      action: "click",
      ref: "p1:1",
    });
    expect(
      calls.find((call) => call.name === "browser_click")?.args,
    ).toMatchObject({
      target_id: "target-1",
      tab_id: "tab-1",
      ref: "p1:1",
      input_route: "dom_event",
    });
    await expect(
      computer.click("p1:1", snapshot.snapshotId - 1),
    ).rejects.toBeInstanceOf(StaleSnapshotError);
  });

  test("reading a just-snapshotted page preserves its refs", async () => {
    const { calls, manager } = fixture();
    const computer = manager.computer("sales-bot");
    const snapshot = await computer.snapshot();
    const semanticReads = () =>
      calls.filter(
        (call) =>
          call.name === "get_browser_state" &&
          call.args.snapshot_format === "semantic_v2",
      ).length;

    expect(semanticReads()).toBe(1);
    await expect(computer.read()).resolves.toMatchObject({
      text: "Example Domain\nThis domain is for examples.",
    });
    expect(semanticReads()).toBe(1);
    await expect(
      computer.click("p1:1", snapshot.snapshotId),
    ).resolves.toMatchObject({ action: "click" });
  });

  test("translates browser key names to Cua Driver key names", async () => {
    const { calls, manager } = fixture();
    const computer = manager.computer("sales-bot");
    const snapshot = await computer.snapshot();

    await computer.type("p1:2", "yes", true, snapshot.snapshotId);
    await computer.key("ArrowDown");
    await computer.humanKey("Backspace");

    expect(
      calls.find(
        (call) => call.name === "browser_type" && call.args.text === "yes\n",
      )?.args,
    ).toMatchObject({ mode: "keystrokes", replace: true });
    expect(
      calls
        .filter((call) => call.name === "press_key")
        .map((call) => call.args.key),
    ).toEqual(["down", "backspace"]);
    expect(
      calls
        .filter((call) => call.name === "press_key")
        .every((call) => call.args.delivery_mode === "foreground"),
    ).toBe(true);
  });

  test("uses browser keystrokes for ref-scoped Enter and refuses ambiguous native keys", async () => {
    const { calls, manager } = fixture();
    const computer = manager.computer("sales-bot");
    const snapshot = await computer.snapshot();

    await computer.key("Enter", "p1:2", snapshot.snapshotId);
    expect(
      calls.find(
        (call) => call.name === "browser_type" && call.args.text === "\n",
      )?.args,
    ).toMatchObject({ mode: "keystrokes", ref: "p1:2" });
    await expect(
      computer.key("Backspace", "p1:2", snapshot.snapshotId),
    ).rejects.toThrow("omit the ref");
  });

  test("only maps the driver's exact stale codes to stale snapshots", async () => {
    const wrongTarget = fixture(({ name }) =>
      name === "browser_click"
        ? refusal("browser_wrong_target_refused", "wrong target refused")
        : undefined,
    );
    const wrongTargetComputer = wrongTarget.manager.computer("sales-bot");
    const wrongTargetSnapshot = await wrongTargetComputer.snapshot();
    const wrongTargetError = await wrongTargetComputer
      .click("p1:1", wrongTargetSnapshot.snapshotId)
      .catch((error) => error);
    expect(wrongTargetError).toBeInstanceOf(Error);
    expect(wrongTargetError).not.toBeInstanceOf(StaleSnapshotError);

    const stale = fixture(({ name }) =>
      name === "browser_click"
        ? refusal("browser_ref_stale", "browser_ref_stale")
        : undefined,
    );
    const staleComputer = stale.manager.computer("sales-bot");
    const staleSnapshot = await staleComputer.snapshot();
    await expect(
      staleComputer.click("p1:1", staleSnapshot.snapshotId),
    ).rejects.toBeInstanceOf(StaleSnapshotError);
  });

  test("returns native screenshots for takeover and closes sessions", async () => {
    const { calls, manager, shutdown } = fixture();
    const computer = manager.computer("sales-bot");

    await expect(computer.screenshot()).resolves.toMatchObject({
      base64: "cG5n",
      width: 900,
      height: 640,
      url: "about:blank",
    });
    expect(await manager.stop("sales-bot")).toBe(true);
    expect(calls.some((call) => call.name === "end_session")).toBe(true);
    await manager.closeAll();
    expect(shutdown()).toBe(true);
  });

  test("rejects profile names that cannot be confined", async () => {
    const { manager } = fixture();
    await expect(manager.computer("../other-bot").read()).rejects.toThrow(
      "only letters, digits, hyphen and underscore",
    );
  });
});

import { expect, test } from "bun:test";
import { startScreencast } from "../src/screencast";

test("navigation messages act on the page the screencast is showing", async () => {
  const effects: string[] = [];
  const client = {
    on() {},
    async send() {},
    async detach() {},
  };
  const page = {
    context: () => ({ newCDPSession: async () => client }),
    goBack: async () => {
      effects.push("back");
    },
    goForward: async () => {
      effects.push("forward");
    },
    reload: async () => {
      effects.push("reload");
    },
  };
  const cast = await startScreencast(page as never, () => {});
  const send = cast.send as (message: unknown) => Promise<void>;

  await send({ type: "navigation", action: "back" });
  await send({ type: "navigation", action: "forward" });
  await send({ type: "navigation", action: "reload" });

  expect(effects).toEqual(["back", "forward", "reload"]);
});

test("unknown navigation actions are ignored", async () => {
  const effects: string[] = [];
  const client = {
    on() {},
    async send() {},
    async detach() {},
  };
  const page = {
    context: () => ({ newCDPSession: async () => client }),
    goBack: async () => {
      effects.push("back");
    },
    goForward: async () => {
      effects.push("forward");
    },
    reload: async () => {
      effects.push("reload");
    },
  };
  const cast = await startScreencast(page as never, () => {});
  const send = cast.send as (message: unknown) => Promise<void>;

  await send({ type: "navigation", action: "not-in-protocol" });

  expect(effects).toEqual([]);
});

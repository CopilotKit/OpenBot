import { expect, test } from "bun:test";
import type { AppSetup } from "@/lib/api/generated/model";
import { directoryProvider } from "@/lib/plugins/provider-vocabulary";

const setup = (extra: Partial<AppSetup>): AppSetup => ({
  directoryAvailable: true,
  directoryProvider: null,
  redirectUri: null,
  authorizesPerAction: false,
  botsMayCallBack: false,
  ...extra,
});

test("a setup that names no directory service answers composio", () => {
  expect(directoryProvider(setup({}))).toBe("composio");
});

test("a setup that names the directory service is believed", () => {
  expect(directoryProvider(setup({ directoryProvider: "arcade" }))).toBe(
    "arcade",
  );
  expect(directoryProvider(setup({ directoryProvider: "composio" }))).toBe(
    "composio",
  );
});

test("no setup yet answers composio", () => {
  expect(directoryProvider(undefined)).toBe("composio");
});

import { expect, test } from "bun:test";
import { isHermesBridgeEndpoint } from "../src/agents/runtime-agents";

test("Hermes bridge credentials match only profile AG-UI paths on the configured origin", () => {
  const bridge = new URL("http://127.0.0.1:4310");

  expect(isHermesBridgeEndpoint("http://127.0.0.1:4310/ag-ui/chief-of-staff", bridge)).toBe(true);
  expect(isHermesBridgeEndpoint("http://127.0.0.1:4310/health", bridge)).toBe(false);
  expect(isHermesBridgeEndpoint("http://127.0.0.1:4311/ag-ui/chief-of-staff", bridge)).toBe(false);
  expect(isHermesBridgeEndpoint("https://127.0.0.1:4310/ag-ui/chief-of-staff", bridge)).toBe(false);
});

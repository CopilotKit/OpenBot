import { expect, test } from "bun:test";
import {
  DEFAULT_APP,
  DEFAULT_WINDOW,
  decodeState,
  encodeState,
  type WorkbenchState,
} from "./urlState";
const views = [{ id: "app-home" }, { id: "setup" }];
test("a shared view preserves route, viewport, role and fake boundary overrides", () => {
  const state: WorkbenchState = {
    scene: "app-home",
    route: "/connections?search=mail#tools",
    window: { ...DEFAULT_WINDOW, width: 1200, theme: "light" },
    app: { ...DEFAULT_APP, host: "browser", role: "owner" },
    env: {},
    answers: { update_offer: { mode: "never" } },
    api: { "GET /api/v2/me": { mode: "fail", status: 503 } },
  };
  expect(decodeState(encodeState(state), views, ["update_offer"])).toEqual({
    state,
    notices: [],
  });
  expect(encodeState(state)).not.toContain("at=");
});
test("defaults to Home and refuses an external route", () => {
  expect(decodeState("", views, []).state.scene).toBe("app-home");
  expect(
    decodeState("route=//example.com", views, []).state.route,
  ).toBeUndefined();
});

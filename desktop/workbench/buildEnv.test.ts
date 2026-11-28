import { expect, test } from "bun:test";
import { workbenchEnvValues } from "./buildEnv";

test("with no .env value the workbench builds like a release installer, Cloud on", () => {
  expect(workbenchEnvValues({}).VITE_OPENBOT_CLOUD_ENABLED).toBe("true");
});

test("a .env value still wins, false included", () => {
  expect(
    workbenchEnvValues({ VITE_OPENBOT_CLOUD_ENABLED: "false" })
      .VITE_OPENBOT_CLOUD_ENABLED,
  ).toBe("false");
  expect(
    workbenchEnvValues({ VITE_OPENBOT_CLOUD_URL: "http://localhost:3000" })
      .VITE_OPENBOT_CLOUD_URL,
  ).toBe("http://localhost:3000");
});

import { expect, test } from "bun:test";
import { viteConfigs } from "../scripts/build";

test("all three builds fold the variant in, so no e2e hook survives a release build", () => {
  for (const variant of ["release", "e2e"] as const) {
    const configs = viteConfigs({ variant, root: "/repo" });
    expect(configs).toHaveLength(3);
    for (const config of configs)
      expect(config.define?.["import.meta.env.RECORDER_VARIANT"]).toBe(
        JSON.stringify(variant),
      );
  }
});

test("the content script and the MAIN-world hook are classic IIFE builds", () => {
  const [, content, mainWorld] = viteConfigs({
    variant: "release",
    root: "/repo",
  });
  for (const config of [content, mainWorld]) {
    const lib = config.build?.lib;
    expect(typeof lib === "object" ? lib.formats : undefined).toEqual(["iife"]);
  }
});

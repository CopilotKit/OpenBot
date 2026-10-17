import { expect, test } from "bun:test";
import { parseBuildVariant, viteConfigs } from "../scripts/build";

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

test("both IIFE builds define process.env.NODE_ENV so a dependency cannot crash the page", () => {
  const [, content, mainWorld] = viteConfigs({
    variant: "release",
    root: "/repo",
  });
  for (const config of [content, mainWorld]) {
    expect(config.define?.["process.env.NODE_ENV"]).toBe(
      JSON.stringify("production"),
    );
    expect(config.define?.["import.meta.env.RECORDER_VARIANT"]).toBe(
      JSON.stringify("release"),
    );
  }
});

test("parseBuildVariant accepts only release (default) or e2e", () => {
  expect(parseBuildVariant(undefined)).toBe("release");
  expect(parseBuildVariant("")).toBe("release");
  expect(parseBuildVariant("release")).toBe("release");
  expect(parseBuildVariant("e2e")).toBe("e2e");
  expect(parseBuildVariant("E2E")).toBeNull();
  expect(parseBuildVariant("prod")).toBeNull();
});

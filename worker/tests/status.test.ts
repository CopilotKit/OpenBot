import { describe, expect, test } from "bun:test";
import { workerStatus } from "../src/status";

describe("worker status", () => {
  test("starts idle before connector jobs are configured", () => {
    expect(workerStatus()).toEqual({ status: "idle" });
  });
});

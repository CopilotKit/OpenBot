import { describe, expect, test } from "bun:test";
import { runConnector } from "../src/connector-runner";

describe("connector runner", () => {
  test("commits a cursor only after every discovered change succeeds", async () => {
    const applied: string[] = [];
    const cursors: string[] = [];

    await runConnector(
      {
        discover: async () => ({
          changes: [{ kind: "delete", sourceId: "one" }],
          nextCursor: "c1",
        }),
      },
      {
        cursor: async () => null,
        apply: async (change) => void applied.push(change.sourceId),
        commitCursor: async (cursor) => void cursors.push(cursor),
      },
    );

    expect(applied).toEqual(["one"]);
    expect(cursors).toEqual(["c1"]);
  });

  test("does not advance the cursor when a change fails", async () => {
    const cursors: string[] = [];

    await expect(
      runConnector(
        {
          discover: async () => ({
            changes: [{ kind: "delete", sourceId: "one" }],
            nextCursor: "c1",
          }),
        },
        {
          cursor: async () => null,
          apply: async () => {
            throw new Error("write failed");
          },
          commitCursor: async (cursor) => void cursors.push(cursor),
        },
      ),
    ).rejects.toThrow("write failed");

    expect(cursors).toEqual([]);
  });

  test("passes reconciliation mode to the adapter and records a successful run", async () => {
    const modes: string[] = [];
    const runs: string[] = [];

    await runConnector(
      {
        discover: async ({ mode }) => {
          modes.push(mode);
          return {
            changes: [{ kind: "delete", sourceId: "one" }],
            nextCursor: null,
          };
        },
      },
      {
        cursor: async () => "c1",
        apply: async () => undefined,
        commitCursor: async () => undefined,
        recordRun: async (status) => void runs.push(status),
      },
      "reconcile",
    );

    expect(modes).toEqual(["reconcile"]);
    expect(runs).toEqual(["succeeded"]);
  });
});

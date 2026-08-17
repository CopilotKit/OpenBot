import { expect, test } from "bun:test";
import { createAgentRegistry } from "../src/agents/registry";

test("reports built-in and remote agent availability without secrets", () => {
  expect(
    createAgentRegistry(
      [
        {
          id: "knowledge",
          name: "Knowledge",
          type: "built_in",
          credentialRef: "openai",
        },
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui",
          endpoint: "https://risk.example/ag-ui",
        },
      ],
      new Set(["openai"]),
    ),
  ).toEqual([
    { id: "knowledge", name: "Knowledge", type: "built_in", available: true },
    { id: "risk", name: "Risk", type: "remote_ag_ui", available: true },
  ]);
});

test("marks unavailable agents with safe reasons", () => {
  expect(
    createAgentRegistry(
      [
        {
          id: "knowledge",
          name: "Knowledge",
          type: "built_in",
          credentialRef: "openai",
        },
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui",
          endpoint: "ftp://risk.example",
        },
      ],
      new Set(),
    ),
  ).toEqual([
    {
      id: "knowledge",
      name: "Knowledge",
      type: "built_in",
      available: false,
      reason: "Model credential is not configured.",
    },
    {
      id: "risk",
      name: "Risk",
      type: "remote_ag_ui",
      available: false,
      reason: "AG-UI endpoint is invalid.",
    },
  ]);
});

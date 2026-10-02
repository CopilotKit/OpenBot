import { describe, expect, test } from "bun:test";
import { validateTenantPackage } from "../src/tenant-package";

/**
 * A package that says the same thing twice.
 *
 * Sync writes one row per entry. Where that is one upsert per entry, a repeat silently became
 * whichever came last; where it is one multi-row INSERT, Postgres refused it and the server stopped
 * at boot with a SQL error naming no file. Each case is refused here instead, with a sentence that
 * says where the repeat is.
 *
 * Kept out of `tenant-package.test.ts` because everything here is validation, and that suite opens a
 * database at import.
 */

const brand = "tenant: { id: fintech, product_name: Ledgerline }";
const model =
  "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }";
const knowledge = "sources: []";
const agent = (id: string, extra = "") =>
  `{ id: ${id}, name: N, title: T, role_description: R., type: built-in, system_prompt: P.${extra} }`;
const skill = (slug: string) =>
  `{ slug: ${slug}, title: T, summary: S, instructions: I }`;

function validate(files: {
  agents: string;
  channels?: string;
  skills?: string;
  agentFiles?: { filename: string; contents: string }[];
}) {
  return validateTenantPackage({
    brand,
    model,
    knowledge,
    themeCss: "",
    channels: "channels: []",
    ...files,
  });
}

describe("a package that repeats itself is refused, not half-applied", () => {
  test("an agent id repeated within agents.yaml", () => {
    expect(() =>
      validate({ agents: `agents: [${agent("x")}, ${agent("x")}]` }),
    ).toThrow('agent "x" is declared twice in agents.yaml');
  });

  test("a skill named twice by one agent", () => {
    expect(() =>
      validate({
        agents: `agents: [${agent("x", ", skills: [s, s]")}]`,
        skills: `skills: [${skill("s")}]`,
      }),
    ).toThrow('agent "x" names skill "s" twice');
  });

  test("a skill slug repeated within skills.yaml", () => {
    expect(() =>
      validate({
        agents: `agents: [${agent("x")}]`,
        skills: `skills: [${skill("s")}, ${skill("s")}]`,
      }),
    ).toThrow('skill "s" is declared twice in skills.yaml');
  });

  test("a channel id repeated within channels.yaml", () => {
    expect(() =>
      validate({
        agents: `agents: [${agent("x")}]`,
        channels:
          "channels: [{ id: c, name: C, description: D, permitted_agents: [x], allowed_groups: [] }, { id: c, name: C2, description: D2, permitted_agents: [x], allowed_groups: [] }]",
      }),
    ).toThrow('channel "c" is declared twice in channels.yaml');
  });

  test("an agent listed twice in one channel", () => {
    expect(() =>
      validate({
        agents: `agents: [${agent("x")}]`,
        channels:
          "channels: [{ id: c, name: C, description: D, permitted_agents: [x, x], allowed_groups: [] }]",
      }),
    ).toThrow('channel "c" lists the same agent twice');
  });

  test("the same agent in two different channels is still fine", () => {
    const { channels } = validate({
      agents: `agents: [${agent("x")}]`,
      channels:
        "channels: [{ id: a, name: A, description: D, permitted_agents: [x], allowed_groups: [] }, { id: b, name: B, description: D, permitted_agents: [x], allowed_groups: [] }]",
    });

    expect(channels.map((channel) => channel.permittedAgents)).toEqual([
      ["x"],
      ["x"],
    ]);
  });
});

describe("an agent left blank in one place and declared in another", () => {
  const blank =
    "agents: [{ id: risk, name: Risk, title: T, role_description: R., type: remote-ag-ui, endpoint: '' }]";
  const declared = `id: risk
name: Risk
title: T
role_description: R.
type: remote-ag-ui
endpoint: https://agents.example.test/ag-ui
`;
  const channels =
    "channels: [{ id: c, name: C, description: D, permitted_agents: [risk], allowed_groups: [] }]";

  test("is declared, so it stays in its channels and is not disabled", () => {
    const result = validate({
      agents: blank,
      channels,
      agentFiles: [{ filename: "risk.yaml", contents: declared }],
    });

    expect(result.agents.map((each) => each.id)).toEqual(["risk"]);
    expect(result.omittedAgentIds).toEqual([]);
    expect(result.channels[0]?.permittedAgents).toEqual(["risk"]);
  });

  test("left blank everywhere, it is still omitted and left out of its channels", () => {
    const result = validate({ agents: blank, channels });

    expect(result.agents).toEqual([]);
    expect(result.omittedAgentIds).toEqual(["risk"]);
    expect(result.channels[0]?.permittedAgents).toEqual([]);
  });
});

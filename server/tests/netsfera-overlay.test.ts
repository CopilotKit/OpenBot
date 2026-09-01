import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
} from "../src/computer/policy";

const overlayPath = "deploy/netsfera/docker-compose.erp-agent.yml";
const policyPath = "deploy/netsfera/agent-computer-policy.json";

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    tool: { name: "computer_navigate" },
    bot: { id: "jefe-erp" },
    actor: { id: "operator" },
    page: { url: "https://erp.netsfera.es", host: "erp.netsfera.es" },
    ...overrides,
  };
}

function renderedOverlayPolicy(): ActionPolicy {
  const directory = mkdtempSync(join(tmpdir(), "openbot-netsfera-overlay-"));
  const basePath = join(directory, "base.yml");
  writeFileSync(basePath, "services:\n  openbot:\n    image: busybox:latest\n");
  try {
    const rendered = Bun.spawnSync([
      "docker",
      "compose",
      "-f",
      basePath,
      "-f",
      overlayPath,
      "config",
      "--format",
      "json",
    ]);
    expect(rendered.exitCode).toBe(0);
    const compose = JSON.parse(rendered.stdout.toString()) as {
      services?: {
        openbot?: { environment?: { AGENT_COMPUTER_POLICY?: string } };
      };
    };
    const policy =
      compose.services?.openbot?.environment?.AGENT_COMPUTER_POLICY;
    expect(typeof policy).toBe("string");
    // `docker compose config` escapes a literal dollar as `$$` in its rendered YAML/JSON. The
    // container receives the single literal dollar used by the CEL regex, so compare that effective
    // value with the reviewed artifact rather than the renderer's transport spelling.
    return JSON.parse((policy as string).replaceAll("$$", "$")) as ActionPolicy;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("the rendered Netsfera production overlay", () => {
  test("has the same executable policy as the reviewed artifact", () => {
    const artifact = JSON.parse(
      readFileSync(policyPath, "utf8"),
    ) as ActionPolicy;
    expect(renderedOverlayPolicy()).toEqual(artifact);
  });

  test.each(["jefe-erp", "recolector-documentos"])(
    "%s is denied every computer tool at G0",
    (botId) => {
      const policy = renderedOverlayPolicy();
      const decision = evaluateActionPolicy(
        policy,
        context({
          bot: { id: botId },
          tool: { name: "computer_navigate" },
          intent: "navigate",
        }),
      );

      expect(decision.allowed).toBe(false);
      expect(decision.source).toBe("deny");
    },
  );
});

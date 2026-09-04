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
    element: { ref: "neutral", role: "button", name: "Open document" },
    ...overrides,
  };
}

function renderedOverlay() {
  const directory = mkdtempSync(join(tmpdir(), "openbot-netsfera-overlay-"));
  const basePath = join(directory, "base.yml");
  writeFileSync(
    basePath,
    [
      "services:",
      "  openbot:",
      "    image: busybox:latest",
      "    build:",
      "      context: .",
      "    ports: [\"127.0.0.1:3001:3001\"]",
      "    security_opt: [no-new-privileges:true]",
      "    volumes: [openbot-data:/data]",
      "    networks: [openbot-hardened]",
      "volumes:",
      "  openbot-data: {}",
      "networks:",
      "  openbot-hardened: {}",
      "",
    ].join("\n"),
  );
  try {
    const base = Bun.spawnSync([
      "docker",
      "compose",
      "-f",
      basePath,
      "config",
      "--format",
      "json",
    ]);
    expect(base.exitCode).toBe(0);
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
    const baseCompose = JSON.parse(base.stdout.toString()) as {
      services?: {
        openbot?: Record<string, unknown>;
      };
    };
    const compose = JSON.parse(rendered.stdout.toString()) as {
      services?: {
        openbot?: Record<string, unknown>;
      };
    };
    return {
      base: baseCompose.services?.openbot,
      overlay: compose.services?.openbot,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function renderedOverlayPolicy(): ActionPolicy {
  const environment = renderedOverlay().overlay?.environment as
    | { AGENT_COMPUTER_POLICY?: string }
    | undefined;
  const policy = environment?.AGENT_COMPUTER_POLICY;
  expect(typeof policy).toBe("string");
  // `docker compose config` escapes a literal dollar as `$$` in its rendered YAML/JSON. The
  // container receives the single literal dollar used by the CEL regex, so compare that effective
  // value with the reviewed artifact rather than the renderer's transport spelling.
  return JSON.parse((policy as string).replaceAll("$$", "$")) as ActionPolicy;
}

function decide(botId: string, toolName: string, host: string) {
  const policy = renderedOverlayPolicy();
  return evaluateActionPolicy(
    policy,
    context({
      bot: { id: botId },
      tool: { name: toolName },
      intent:
        toolName === "computer_navigate"
          ? "navigate"
          : toolName === "computer_write_file"
            ? "write_file"
            : toolName === "computer_run_command"
              ? "run_command"
              : "read",
      page: {
        host,
        url: host ? `https://${host}/` : "",
      },
    }),
  );
}

function changedPaths(
  before: unknown,
  after: unknown,
  prefix = "",
): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

  if (isObjectRecord(before) || isObjectRecord(after)) {
    const beforeObject = isObjectRecord(before) ? before : {};
    const afterObject = isObjectRecord(after) ? after : {};
    return [...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])]
      .flatMap((key) =>
        changedPaths(
          beforeObject[key],
          afterObject[key],
          prefix ? `${prefix}.${key}` : key,
        ),
      )
      .sort();
  }

  if (
    before === null || after === null || typeof before !== typeof after
  ) {
    return [prefix];
  }
  return [prefix];
}

describe("the rendered Netsfera production overlay", () => {
  test("has the same executable policy as the reviewed artifact", () => {
    const artifact = JSON.parse(
      readFileSync(policyPath, "utf8"),
    ) as ActionPolicy;
    expect(renderedOverlayPolicy()).toEqual(artifact);
  });

  test("selects the Netsfera app build without changing the hardened topology", () => {
    const { base, overlay } = renderedOverlay();

    expect(overlay?.build).toMatchObject({
      args: { TENANT_PACKAGE_DIR: "../examples/netsfera" },
    });
    expect(overlay).toMatchObject({
      image: base?.image,
      ports: base?.ports,
      security_opt: base?.security_opt,
      volumes: base?.volumes,
      networks: base?.networks,
    });
  });

  test("changes only the reviewed build and runtime configuration", () => {
    const { base, overlay } = renderedOverlay();

    expect(changedPaths(base, overlay)).toEqual([
      "build.args.TENANT_PACKAGE_DIR",
      "environment.AGENT_COMPUTER_POLICY",
      "environment.TENANT_PACKAGE_DIR",
    ]);
  });

  test.each([
    ["jefe-erp", "computer_navigate", "chatgpt.com", false],
    ["recolector-documentos", "computer_navigate", "chatgpt.com", true],
    ["recolector-documentos", "computer_navigate", "evil.example", false],
    ["recolector-documentos", "computer_run_command", "", false],
    ["recolector-documentos", "computer_write_file", "", false],
  ])("governs %s %s on %s", (botId, toolName, host, allowed) => {
    expect(decide(botId, toolName, host).allowed).toBe(allowed);
  });

  test.each([
    "Purchase subscription",
    "Upgrade plan",
    "Payment method",
    "API key",
    "Password",
  ])("denies collector interaction with sensitive element %s", (name) => {
    const decision = evaluateActionPolicy(
      renderedOverlayPolicy(),
      context({
        bot: { id: "recolector-documentos" },
        tool: { name: "computer_click" },
        intent: "activate",
        page: { host: "chatgpt.com", url: "https://chatgpt.com/settings" },
        element: { ref: "sensitive", role: "button", name },
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("deny");
  });

  test.each([
    ["computer_list_files", "downloads/", true],
    ["computer_read_file", "downloads/invoice.pdf", true],
    ["computer_list_files", "workspace/", false],
    ["computer_read_file", "workspace/secrets.env", false],
  ])("permits %s only in downloads/", (toolName, path, allowed) => {
    const decision = evaluateActionPolicy(
      renderedOverlayPolicy(),
      context({
        bot: { id: "recolector-documentos" },
        tool: { name: toolName },
        intent: toolName === "computer_list_files" ? "list_files" : "read_file",
        page: { host: "", url: "" },
        file: { path, name: path.split("/").at(-1) ?? "", extension: "" },
      }),
    );

    expect(decision.allowed).toBe(allowed);
  });
});

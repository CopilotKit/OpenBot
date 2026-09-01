import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = "deploy/netsfera/verify-rendered-overlay.sh";
const reviewedPolicy = JSON.stringify(
  JSON.parse(readFileSync("deploy/netsfera/agent-computer-policy.json", "utf8")),
);

function renderedStack(options: {
  g0?: boolean;
  openbot?: Record<string, unknown>;
  supervisor?: Record<string, unknown>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  configs?: Record<string, unknown>;
  additionalServices?: Record<string, unknown>;
  extraOpenbotEnvironment?: Record<string, string>;
} = {}) {
  const baseOpenbot = {
    image: "openbot:test",
    build: { context: "/opt/openbot/source", dockerfile: "Dockerfile" },
    environment: { EXISTING_SETTING: "unchanged" },
    ports: ["127.0.0.1:3001:3001"],
    security_opt: ["no-new-privileges:true"],
    volumes: ["openbot-data:/data"],
    networks: { hardened: null },
  };
  return JSON.stringify({
    services: {
      openbot: {
        ...baseOpenbot,
        ...(options.g0
          ? {
              build: {
                ...baseOpenbot.build,
                args: { TENANT_PACKAGE_DIR: "../examples/netsfera" },
              },
              environment: {
                ...baseOpenbot.environment,
                TENANT_PACKAGE_DIR: "../examples/netsfera",
                AGENT_COMPUTER_POLICY: reviewedPolicy,
                ...options.extraOpenbotEnvironment,
              },
            }
          : {}),
        ...options.openbot,
      },
      supervisor: {
        image: "supervisor:test",
        security_opt: ["no-new-privileges:true"],
        networks: { hardened: null },
        ...options.supervisor,
      },
      ...options.additionalServices,
    },
    networks: { hardened: { external: true }, ...options.networks },
    volumes: { "openbot-data": {}, ...options.volumes },
    secrets: { database_url: { name: "database_url" }, ...options.secrets },
    configs: { base_config: { name: "base_config" }, ...options.configs },
  });
}

function runsRenderedOverlayVerification(
  candidateOptions: Parameters<typeof renderedStack>[0] = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "openbot-render-check-"));
  try {
    const stat = join(directory, "stat");
    const baseRender = join(directory, "base.json");
    const candidateRender = join(directory, "candidate.json");
    writeFileSync(baseRender, renderedStack(), { mode: 0o600 });
    writeFileSync(candidateRender, renderedStack({ g0: true, ...candidateOptions }), { mode: 0o600 });
    writeFileSync(stat, '#!/usr/bin/env bash\nprintf "%s\\n" 600\n');
    chmodSync(stat, 0o755);

    return Bun.spawnSync(["bash", scriptPath, baseRender, candidateRender], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the private renderer permits only the reviewed full-stack changes", () => {
  const result = runsRenderedOverlayVerification();

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("verified private candidate");
});

test("the private renderer rejects an OpenBot topology change", () => {
  const result = runsRenderedOverlayVerification({
    openbot: { privileged: true },
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("unreviewed rendered-stack change");
});

test("the private renderer rejects another service changing", () => {
  const result = runsRenderedOverlayVerification({
    supervisor: { privileged: true },
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("unreviewed rendered-stack change");
});

test("the private renderer rejects an added service", () => {
  const result = runsRenderedOverlayVerification({
    additionalServices: { exfiltrator: { image: "unexpected:test" } },
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("unreviewed rendered-stack change");
});

test("the private renderer rejects an extra OpenBot environment variable", () => {
  const result = runsRenderedOverlayVerification({
    extraOpenbotEnvironment: { UNREVIEWED_SETTING: "1" },
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("unreviewed rendered-stack change");
});

test("the private renderer rejects a top-level network change", () => {
  const result = runsRenderedOverlayVerification({
    networks: { hardened: { external: false } },
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("unreviewed rendered-stack change");
});

test.each([
  ["volume", { volumes: { "openbot-data": { external: true } } }],
  ["secret", { secrets: { database_url: { name: "other_database_url" } } }],
  ["config", { configs: { base_config: { name: "other_config" } } }],
])("the private renderer rejects a top-level %s change", (_, candidateOptions) => {
  const result = runsRenderedOverlayVerification(candidateOptions);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("unreviewed rendered-stack change");
});

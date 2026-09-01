import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
    },
    networks: { hardened: { external: true }, ...options.networks },
    volumes: { "openbot-data": {} },
    secrets: { database_url: { name: "database_url" } },
    configs: { base_config: { name: "base_config" } },
  });
}

function runsRenderedOverlayVerification(
  candidateOptions: Parameters<typeof renderedStack>[0] = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "openbot-render-check-"));
  try {
    const docker = join(directory, "docker");
    const stat = join(directory, "stat");
    const bun = join(directory, "bun");
    const baseRender = join(directory, "base.json");
    const candidateRender = join(directory, "candidate.json");
    writeFileSync(baseRender, "", { mode: 0o600 });
    writeFileSync(candidateRender, "", { mode: 0o600 });
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
for argument in "$@"; do
  if [[ "$argument" == *docker-compose.erp-agent.yml ]]; then
    printf '%s\\n' '${renderedStack({ g0: true, ...candidateOptions })}'
    exit 0
  fi
done
printf '%s\\n' '${renderedStack()}'
`,
    );
    writeFileSync(stat, '#!/usr/bin/env bash\nprintf "%s\\n" 600\n');
    chmodSync(docker, 0o755);
    chmodSync(stat, 0o755);
    symlinkSync(process.execPath, bun);

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

test("the private renderer rejects a top-level network change", () => {
  const result = runsRenderedOverlayVerification({
    networks: { hardened: { external: false } },
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("unreviewed rendered-stack change");
});

import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = "deploy/netsfera/verify-rendered-overlay.sh";

function renderedOpenbot(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    services: {
      openbot: {
        image: "openbot:test",
        build: { context: ".", args: { TENANT_PACKAGE_DIR: "../examples/netsfera" } },
        environment: {
          TENANT_PACKAGE_DIR: "../examples/netsfera",
          AGENT_COMPUTER_POLICY: "{}",
        },
        ports: ["127.0.0.1:3001:3001"],
        security_opt: ["no-new-privileges:true"],
        volumes: ["openbot-data:/data"],
        networks: { hardened: null },
        ...extra,
      },
    },
  });
}

function runsRenderedOverlayVerification(g0Extra: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "openbot-render-check-"));
  try {
    const docker = join(directory, "docker");
    const stat = join(directory, "stat");
    const bun = join(directory, "bun");
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
for argument in "$@"; do
  if [[ "$argument" == *docker-compose.erp-agent.yml ]]; then
    cat <<'JSON'
${renderedOpenbot(g0Extra)}
JSON
    exit 0
  fi
done
cat <<'JSON'
${JSON.stringify({
  services: {
    openbot: {
      image: "openbot:test",
      build: { context: "." },
      ports: ["127.0.0.1:3001:3001"],
      security_opt: ["no-new-privileges:true"],
      volumes: ["openbot-data:/data"],
      networks: { hardened: null },
    },
  },
})}
JSON
`,
    );
    writeFileSync(stat, '#!/usr/bin/env bash\nprintf "%s\\n" 600\n');
    chmodSync(docker, 0o755);
    chmodSync(stat, 0o755);
    symlinkSync(process.execPath, bun);

    return Bun.spawnSync(["bash", scriptPath], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the private rendered-overlay verifier permits only the reviewed changes", () => {
  const result = runsRenderedOverlayVerification();

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("preserves reviewed OpenBot");
});

test("the private rendered-overlay verifier rejects a topology change", () => {
  const result = runsRenderedOverlayVerification({ privileged: true });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("unreviewed OpenBot setting");
});

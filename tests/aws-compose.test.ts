import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const deployRoot = join(repositoryRoot, "deploy", "aws");
const digest = `sha256:${"a".repeat(64)}`;

interface ComposeService {
  environment: Record<string, string>;
  read_only: boolean;
  cap_drop: string[];
  security_opt: string[];
  ports: Array<{ target: number; published: string }>;
  deploy: { resources: { limits: { memory: string } } };
  volumes: Array<{ source: string; target: string; read_only?: boolean }>;
  command: string[];
}

function renderCompose(file: string, profile?: string) {
  const temporary = mkdtempSync(join(tmpdir(), "openbot-aws-compose-"));
  const envFile = join(temporary, "runtime.env");
  writeFileSync(envFile, "PLACEHOLDER=not-a-secret\n");
  try {
    const args = [
      "compose",
      "--env-file",
      "/dev/null",
      "-f",
      join(deployRoot, file),
      ...(profile ? ["--profile", profile] : []),
      "config",
      "--format",
      "json",
    ];
    return JSON.parse(
      execFileSync("docker", args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          AWS_REGION: "us-east-1",
          CONTROL_LOG_GROUP: "/openbot/test/control",
          WORKER_LOG_GROUP: "/openbot/test/worker",
          CONTROL_ENV_FILE: envFile,
          WORKER_ENV_FILE: envFile,
          OPENBOT_IMAGE: `example.invalid/openbot@${digest}`,
          POSTGRES_IMAGE: `example.invalid/postgres@${digest}`,
          CADDY_IMAGE: `example.invalid/caddy@${digest}`,
          GATEWAY_IMAGE: `example.invalid/gateway@${digest}`,
          POSTGRES_PASSWORD: "placeholder",
          DATABASE_URL: "postgres://openbot:placeholder@postgres:5432/openbot",
          CODEX_GATEWAY_TOKEN: "codex-placeholder",
          CLAUDE_GATEWAY_TOKEN: "claude-placeholder",
          GROK_GATEWAY_TOKEN: "grok-placeholder",
          REPOSITORY_URL: "https://github.com/Tbsheff/OpenBot.git",
          BASE_BRANCH: "main",
          OPENBOT_DOMAIN: "openbot.example.com",
          WORKER_SHARED_SECRET: "placeholder",
        },
      }),
    ) as {
      services: Record<string, ComposeService>;
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test("renders one hardened gateway per provider with fixed private ports", () => {
  const config = renderCompose("compose.worker.yml", "*");
  const expected = { codex: 4210, claude: 4211, grok: 4212 } as const;

  for (const [provider, port] of Object.entries(expected)) {
    const service = config.services[`${provider}-gateway`];
    expect(service.environment.PROVIDER).toBe(provider);
    expect(service.environment.PORT).toBe(String(port));
    expect(service.environment.GATEWAY_TOKEN).toBe(`${provider}-placeholder`);
    expect(service.read_only).toBe(true);
    expect(service.cap_drop).toContain("ALL");
    expect(service.security_opt).toContain("no-new-privileges:true");
    expect(service.ports).toContainEqual(
      expect.objectContaining({ target: port, published: String(port) }),
    );
    expect(service.deploy.resources.limits.memory).toBeTruthy();
  }
  expect(config.services["codex-gateway"].security_opt).toContain(
    "seccomp=unconfined",
  );
  expect(config.services["claude-gateway"].security_opt).not.toContain(
    "seccomp=unconfined",
  );
  expect(config.services["grok-gateway"].security_opt).toContain(
    "seccomp=unconfined",
  );
});

test("keeps each provider auth mount distinct while sharing only gateway state", () => {
  const config = renderCompose("compose.worker.yml", "*");
  const authTargets = {
    codex: "/home/gateway/.codex",
    claude: "/home/gateway/.claude",
    grok: "/home/gateway/.grok",
  } as const;

  for (const provider of Object.keys(authTargets) as Array<
    keyof typeof authTargets
  >) {
    const service = config.services[`${provider}-gateway`];
    const volumes = service.volumes as Array<{
      source: string;
      target: string;
    }>;
    expect(volumes).toContainEqual(
      expect.objectContaining({
        source: `/srv/openbot-auth/${provider}`,
        target: authTargets[provider],
      }),
    );
    expect(volumes).toContainEqual(
      expect.objectContaining({
        source: "/srv/openbot-worker/state",
        target: "/var/lib/openbot-gateway",
      }),
    );
    for (const other of Object.keys(authTargets).filter(
      (name) => name !== provider,
    )) {
      expect(
        volumes.some((volume) =>
          volume.source.includes(`/openbot-auth/${other}`),
        ),
      ).toBe(false);
    }
  }

  expect(config.services["codex-gateway"].volumes).toContainEqual(
    expect.objectContaining({
      source: join(deployRoot, "codex-config.toml"),
      target: "/home/gateway/.codex/config.toml",
      read_only: true,
    }),
  );
});

test("keeps the Claude subscription service off until its release gate passes", () => {
  const defaultConfig = renderCompose("compose.worker.yml");
  const enabledConfig = renderCompose(
    "compose.worker.yml",
    "claude-subscription",
  );

  expect(defaultConfig.services["claude-gateway"]).toBeUndefined();
  expect(enabledConfig.services["claude-gateway"]).toBeTruthy();
});

test("does not expose host control surfaces to gateway containers", () => {
  const source = readFileSync(join(deployRoot, "compose.worker.yml"), "utf8");

  expect(source).not.toContain("/var/run/docker.sock");
  expect(source).toContain('AWS_EC2_METADATA_DISABLED: "true"');
  expect(source).toContain(
    "HOST_SEMAPHORE_PATH: /var/lib/openbot-gateway/host-semaphore.sqlite",
  );
  expect(source).toContain("read_only: true");
});

test("renders the TLS control stack and external scheduled jobs", () => {
  const config = renderCompose("compose.control.yml", "jobs");

  expect(Object.keys(config.services)).toEqual(
    expect.arrayContaining([
      "postgres",
      "openbot",
      "caddy",
      "routine-sweep",
      "attachment-cleanup",
      "database-backup",
      "migrate",
    ]),
  );
  expect(config.services.caddy.ports).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 80, published: "80" }),
      expect.objectContaining({ target: 443, published: "443" }),
    ]),
  );
  expect(config.services["routine-sweep"].command).toContain(
    "scripts/fire-routines.ts",
  );
  expect(config.services["attachment-cleanup"].command).toContain(
    "scripts/cull-staged-attachments.ts",
  );
  expect(config.services.migrate.command.join(" ")).toContain(
    "scripts/migrate.ts",
  );
  expect(config.services["database-backup"].command.join(" ")).toContain(
    "pg_dump",
  );
  expect(config.services["routine-sweep"].environment).not.toHaveProperty(
    "CODEX_HOME",
  );
  expect(config.services["routine-sweep"].environment).not.toHaveProperty(
    "CLAUDE_CONFIG_DIR",
  );
  expect(config.services["routine-sweep"].environment).not.toHaveProperty(
    "GROK_HOME",
  );
});

test("requires digest-qualified production image inputs", () => {
  const control = readFileSync(join(deployRoot, "compose.control.yml"), "utf8");
  const worker = readFileSync(join(deployRoot, "compose.worker.yml"), "utf8");

  for (const variable of ["OPENBOT_IMAGE", "POSTGRES_IMAGE", "CADDY_IMAGE"]) {
    expect(control).toContain(
      `\${${variable}:?set a digest-qualified image reference}`,
    );
  }
  expect(worker).toMatch(
    /\$\{GATEWAY_IMAGE:\?set a digest-qualified image reference\}/,
  );
  expect(`${control}\n${worker}`).not.toMatch(/image:\s+[^\n]*:latest\b/);
});

test("installs system services for Compose, metadata blocking, and both schedules", () => {
  const systemd = join(deployRoot, "systemd");
  const unitNames = [
    "openbot-control.service",
    "openbot-worker.service",
    "openbot-worker-firewall.service",
    "openbot-routines.timer",
    "openbot-routines.service",
    "openbot-attachment-cleanup.timer",
    "openbot-attachment-cleanup.service",
    "openbot-database-backup.timer",
    "openbot-database-backup.service",
    "openbot-health-metrics.timer",
    "openbot-health-metrics.service",
  ];

  for (const unit of unitNames) {
    expect(readFileSync(join(systemd, unit), "utf8").trim()).not.toBeEmpty();
  }
  expect(
    readFileSync(join(deployRoot, "bin", "worker-firewall"), "utf8"),
  ).toContain("169.254.169.254/32");
});

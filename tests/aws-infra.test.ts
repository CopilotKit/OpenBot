import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..", "infra", "aws");

function terraformFiles(directory = root): string[] {
  return readdirSync(directory)
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory()
        ? terraformFiles(path)
        : path.endsWith(".tf")
          ? [path]
          : [];
    })
    .sort();
}

function terraformText(): string {
  return terraformFiles()
    .map((path) => `# ${relative(root, path)}\n${readFileSync(path, "utf8")}`)
    .join("\n");
}

test("uses the fixed two-host EC2 shape without costly managed services", () => {
  const source = terraformText();

  expect(source).toMatch(/instance_type\s*=\s*"t3\.medium"/);
  expect(source).toMatch(/instance_type\s*=\s*"t3\.xlarge"/);
  expect(source).toContain("al2023-ami-kernel-default-x86_64");
  for (const resource of [
    "aws_eks_cluster",
    "aws_nat_gateway",
    "aws_lb",
    "aws_db_instance",
  ]) {
    expect(source).not.toContain(`resource "${resource}"`);
  }
});

test("opens only TLS on control and only the three gateway ports from control", () => {
  const network = readFileSync(
    join(root, "modules", "network", "main.tf"),
    "utf8",
  );

  expect(network).toContain('for_each = toset(["80", "443"])');
  expect(network).toContain('for_each = toset(["4210", "4211", "4212"])');
  expect(network).toMatch(
    /referenced_security_group_id\s*=\s*aws_security_group\.control\.id/,
  );
  expect(network).not.toMatch(/from_port\s*=\s*22\b/);
  expect(network).not.toMatch(/to_port\s*=\s*22\b/);
  const workerIngress = network.slice(
    network.indexOf(
      'resource "aws_vpc_security_group_ingress_rule" "worker_gateway"',
    ),
    network.indexOf('resource "aws_vpc_security_group_egress_rule" "worker"'),
  );
  expect(workerIngress).not.toContain("cidr_ipv4");
});

test("uses SSM, exact ECR and log permissions, and no wildcard IAM action", () => {
  const source = terraformText();

  expect(source).toContain("AmazonSSMManagedInstanceCore");
  expect(source).toContain("ecr:GetAuthorizationToken");
  expect(source).toContain("ecr:BatchGetImage");
  expect(source).toContain("logs:PutLogEvents");
  expect(source).not.toMatch(/actions\s*=\s*\[[^\]]*"\*"/s);
});

test("requires IMDSv2 and retains encrypted data and provider auth volumes", () => {
  const source = terraformText();

  expect(source.match(/http_tokens\s*=\s*"required"/g)?.length).toBe(2);
  expect(source.match(/http_put_response_hop_limit\s*=\s*1/g)?.length).toBe(2);
  expect(source.match(/encrypted\s*=\s*true/g)?.length).toBeGreaterThanOrEqual(
    5,
  );
  expect(source).toContain('providers = toset(["codex", "claude", "grok"])');
  expect(
    source.match(/delete_on_termination\s*=\s*false/g)?.length,
  ).toBeGreaterThanOrEqual(2);
  expect(
    source.match(/skip_destroy\s*=\s*true/g)?.length,
  ).toBeGreaterThanOrEqual(2);
  expect(
    source.match(/prevent_destroy\s*=\s*true/g)?.length,
  ).toBeGreaterThanOrEqual(3);
  expect(source).toMatch(/Backup\s*=\s*"excluded-provider-auth"/);
  expect(source).toMatch(/Backup\s*=\s*"included-service-data"/);
});

test("gives control a stable address and worker a private DNS record", () => {
  const source = terraformText();

  expect(source).toContain('resource "aws_eip" "control"');
  expect(source).toContain('resource "aws_route53_zone" "private"');
  expect(source).toContain('resource "aws_route53_record" "worker"');
  expect(source).toContain("worker.openbot.internal");
});

test("passes only secret references through Terraform and pins providers", () => {
  const source = terraformText();

  expect(source).toContain('version = "= 6.14.1"');
  expect(source).toContain("control_secret_arns");
  expect(source).toContain("worker_secret_arns");
  expect(source).not.toContain("aws_secretsmanager_secret_version");
  expect(source).not.toMatch(/secret_string\s*=/);
});

test("backs up only service data and provisions owner alerts", () => {
  const source = terraformText();

  expect(source).toContain('resource "aws_backup_plan" "daily"');
  expect(source).toContain('value = "included-service-data"');
  expect(source).not.toMatch(
    /selection_tag[\s\S]{0,200}excluded-provider-auth/,
  );
  expect(source).toContain('namespace           = "OpenBot/Personal"');
  expect(source).toContain('resource "aws_sns_topic" "alerts"');
  expect(source).toContain('metric_name         = "QueueDepth"');
  expect(source).toContain('metric_name         = "DiskUsedPercent"');
});

test("limits the GitHub deploy role to production OIDC and deployment resources", () => {
  const source = terraformText();

  expect(source).toContain("AssumeRoleWithWebIdentity");
  expect(source).toContain(
    ["repo:", "$", "{var.github_repository}", ":environment:production"].join(
      "",
    ),
  );
  expect(source).toContain("token.actions.githubusercontent.com:aud");
  expect(source).toContain("AWS-RunShellScript");
  expect(source).toContain("secretsmanager:PutSecretValue");
});

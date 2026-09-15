import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("documents the complete AWS launch and honest end-to-end gate", () => {
  const deployment = read("docs/runbooks/aws-deployment.md");

  for (const required of [
    "Terraform",
    "Secrets Manager",
    "GitHub Actions OIDC",
    "production",
    "DNS",
    "TLS",
    "provider device sign-ins",
    "container replacement",
    "not prove the AWS path",
  ]) {
    expect(deployment).toContain(required);
  }
});

test("documents alerts, rollback, backup restore, and cost checks", () => {
  const operations = read("docs/runbooks/worker-operations.md");

  for (const required of [
    "ServiceReady",
    "QueueDepth",
    "manual rollback",
    "pg_restore",
    "Backup=excluded-provider-auth",
    "AWS Pricing Calculator",
  ]) {
    expect(operations).toContain(required);
  }
});

test("keeps provider sign-ins out of shared secret stores and gates Claude", () => {
  const signIn = read("docs/runbooks/provider-sign-in.md");

  expect(signIn).toContain(
    "Do not put provider credentials in AWS Secrets Manager",
  );
  expect(signIn).toContain("Claude release gate");
  expect(signIn).toContain("written guidance from Anthropic");
  expect(signIn).toContain("codex login --device-auth");
  expect(signIn).toContain("grok login --device-auth");
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The settings the deployment documents tell an operator to set, and the one reference that
 * explains them.
 *
 * `docs/configuration.md` is what both deployment docs point at for the meaning of a setting
 * ("Full reference", README.md), so a command that sets a variable the reference never names leaves
 * an operator with a working image tag and no page that says what the variable does, whether it is
 * required, or what it interacts with. The one-container `docker run` sets `EMBEDDED_POSTGRES` and
 * mounts a volume for it; the reference named neither, and called `DATABASE_URL` required without
 * the exception that a database inside the container is.
 */
const ROOT = join(import.meta.dir, "..");
const REFERENCE = join(ROOT, "docs", "configuration.md");

/** The deployment documents: the ones an operator reads before their first container. */
const DEPLOYMENT_DOCS = ["README.md", join("docs", "deployment.md")];

/**
 * Every setting a document tells an operator to set in a command: `-e NAME=value` on a `docker run`,
 * and `NAME=value` at the start of a line in a shell block (which covers `export`, and a commented
 * example of the same block).
 */
function settingsSetBy(document: string): string[] {
  const text = readFileSync(join(ROOT, document), "utf8");
  const names = new Set<string>();
  for (const block of text.matchAll(/```sh\n([\s\S]*?)```/g)) {
    for (const found of block[1].matchAll(/(?:^|\s)-e\s+([A-Z][A-Z0-9_]+)=/g))
      names.add(found[1] as string);
    for (const found of block[1].matchAll(
      /^\s*(?:#\s*)?(?:export\s+)?([A-Z][A-Z0-9_]+)=/gm,
    ))
      names.add(found[1] as string);
  }
  return [...names].sort();
}

test("every setting the deployment docs tell an operator to set is named by the reference", () => {
  const reference = readFileSync(REFERENCE, "utf8");
  const missing: string[] = [];
  for (const document of DEPLOYMENT_DOCS)
    for (const name of settingsSetBy(document))
      if (!new RegExp(`\\b${name}\\b`).test(reference))
        missing.push(
          `${document} sets ${name}, which the reference never names`,
        );
  expect(missing).toEqual([]);
});

/**
 * The one-container mount is the whole reason `EMBEDDED_POSTGRES` exists, and the reference is
 * where the exception to `DATABASE_URL` belongs: `docs/deployment.md` says a database inside the
 * container needs no `DATABASE_URL`, while the reference listed it as required with no exception.
 */
test("the reference says which volume the embedded database needs, and that it needs no DATABASE_URL", () => {
  const reference = readFileSync(REFERENCE, "utf8");
  expect(reference).toContain("`EMBEDDED_POSTGRES`");
  // The parent, which is the mount the README, deployment.md and the changelog all name. Mounting the
  // data directory itself leaves initdb refusing a non-empty directory on an ext4 platform volume.
  expect(reference).toContain("`/var/lib/postgresql`");
  expect(reference).toMatch(
    /`EMBEDDED_POSTGRES`[\s\S]{0,400}[Nn]ot needed with|Not needed with `EMBEDDED_POSTGRES=on`|no `DATABASE_URL`/,
  );
});

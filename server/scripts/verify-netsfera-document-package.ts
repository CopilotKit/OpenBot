import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { loadTenantPackage } from "../src/tenant-package";

// Offline inspection only: no synchronization, secrets or database connection.
const directory = process.argv[2];
if (!directory)
  throw new Error(
    "usage: verify-netsfera-document-package.ts <package-directory>",
  );
const loaded = await loadTenantPackage(directory);
const raw = parse(await readFile(join(directory, "agents.yaml"), "utf8"));
const result: Record<string, { computerAccess: string; skills: string[] }> = {};
for (const [id, access, skills] of [
  ["jefe-erp", "disabled", []],
  [
    "recolector-documentos",
    "enabled",
    ["crear-proveedor-documental", "skill-creator"],
  ],
] as const) {
  const agents = loaded.agents.filter((entry) => entry.id === id);
  const definitions = raw.agents.filter(
    (entry: { id: string }) => entry.id === id,
  );
  if (agents.length !== 1 || definitions.length !== 1) {
    throw new Error(`Expected exactly one document agent definition: ${id}`);
  }
  const [agent] = agents;
  const [definition] = definitions;
  // Package loader ignores unknown keys. Fail closed on undeclared capability
  // fields rather than letting a future loader silently turn them into grants.
  const allowed = new Set([
    "id",
    "name",
    "title",
    "role_description",
    "avatar_seed",
    "type",
    "computer_access",
    "system_prompt",
    "skills",
  ]);
  if (
    !agent ||
    !definition ||
    Object.keys(definition).some((key) => !allowed.has(key))
  ) {
    throw new Error(`Unexpected document agent definition: ${id}`);
  }
  const actualSkills = [...agent.skills].sort();
  if (
    agent.configuration.computerAccess !== access ||
    JSON.stringify(actualSkills) !== JSON.stringify(skills)
  ) {
    throw new Error(
      `Unexpected document agent access or package skills: ${id}`,
    );
  }
  result[id] = { computerAccess: access, skills: actualSkills };
}
console.log(JSON.stringify(result));

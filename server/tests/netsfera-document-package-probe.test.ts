import { expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packagePath = resolve(import.meta.dir, "../../examples/netsfera");
const script = resolve(
  import.meta.dir,
  "../scripts/verify-netsfera-document-package.ts",
);

test.each([
  "valid",
  "chief-browser",
  "collector-disabled",
  "missing-skill",
  "extra-skill",
  "mcp",
  "bot",
])(
  "stopped-image package probe checks %s without credentials or a database",
  (variant) => {
    const directory = mkdtempSync(join(tmpdir(), "document-probe-"));
    try {
      cpSync(packagePath, directory, { recursive: true });
      const path = join(directory, "agents.yaml");
      let contents = readFileSync(path, "utf8");
      if (variant === "chief-browser")
        contents = contents.replace(
          "computer_access: disabled",
          "computer_access: enabled",
        );
      if (variant === "collector-disabled")
        contents = contents.replace(
          "computer_access: enabled",
          "computer_access: disabled",
        );
      if (variant === "missing-skill")
        contents = contents.replace("      - skill-creator\n", "");
      if (variant === "extra-skill") contents += "      - unexpected\n";
      if (variant === "mcp") contents += "    mcp_servers: [forbidden]\n";
      if (variant === "bot") contents += "    bots: [jefe-erp]\n";
      writeFileSync(path, contents);
      const result = Bun.spawnSync([process.execPath, script, directory], {
        env: { PATH: process.env.PATH! },
      });
      if (variant === "valid") {
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(JSON.parse(result.stdout.toString())).toEqual({
          "jefe-erp": { computerAccess: "disabled", skills: [] },
          "recolector-documentos": {
            computerAccess: "enabled",
            skills: ["crear-proveedor-documental", "skill-creator"],
          },
        });
      } else expect(result.exitCode).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

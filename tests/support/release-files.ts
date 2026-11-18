import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A folder of release files as the OpenBot images of one version publish them: the `openbot` and
 * `openbot-bundle` charts, packaged with real `helm package`, and the `openbot-release.json` that
 * names them and the last migration the server of that version applies.
 */
export function releaseFiles({
  version,
  database,
  appVersion = version.slice(1),
  charts = { openbot: "0.3.0", "openbot-bundle": "0.1.0" },
  requiresDowntime,
}: {
  version: string;
  database: string;
  /** What each packaged chart says it installs. A release's charts say the release. */
  appVersion?: string;
  charts?: Record<string, string>;
  /**
   * The `openbot` chart's `openbot.ai/requires-downtime` annotation. Left out, the chart has none, as
   * a chart from before it did not.
   */
  requiresDowntime?: boolean;
}): string {
  const work = mkdtempSync(join(tmpdir(), "openbot-release-files-"));
  const directory = join(work, "release");
  mkdirSync(directory);
  const listed: Record<string, { version: string; sha256: string }> = {};
  for (const [name, own] of Object.entries(charts)) {
    const source = join(work, "source", name);
    mkdirSync(join(source, "templates"), { recursive: true });
    const annotations =
      name === "openbot" && requiresDowntime !== undefined
        ? `annotations:\n  openbot.ai/requires-downtime: "${requiresDowntime}"\n`
        : "";
    writeFileSync(
      join(source, "Chart.yaml"),
      `apiVersion: v2\nname: ${name}\nversion: ${own}\nappVersion: "${appVersion}"\n${annotations}`,
    );
    writeFileSync(join(source, "values.yaml"), "replicas: 1\n");
    writeFileSync(
      join(source, "templates/configmap.yaml"),
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}\n",
    );
    execFileSync("helm", ["package", source, "--destination", directory], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    listed[name] = {
      version: own,
      sha256: createHash("sha256")
        .update(readFileSync(join(directory, `${name}-${own}.tgz`)))
        .digest("hex"),
    };
  }
  writeFileSync(
    join(directory, "openbot-release.json"),
    `${JSON.stringify({ version, database, charts: listed }, null, 2)}\n`,
  );
  return directory;
}

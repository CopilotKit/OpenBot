import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

export function shellDistribution(env: Record<string, string | undefined>) {
  const repository = env.OPENBOT_RELEASE_REPOSITORY || "CopilotKit/OpenBot";
  return {
    id: env.OPENBOT_DISTRIBUTION_ID || repository,
    repository,
    channel: env.OPENBOT_RELEASE_CHANNEL || "stable",
  };
}

type Platform = { target: string; url: string; signature: string };
export function shellUpdateManifest(
  version: string,
  platforms: Platform[],
  distribution: { id: string; repository: string; channel: string },
) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
    throw new Error("Expected exact native application semver");
  if (
    !distribution.id.trim() ||
    !/^[\w.-]+\/[\w.-]+$/.test(distribution.repository) ||
    !distribution.channel.trim()
  )
    throw new Error("Invalid native distributor identity");
  const values: Record<string, { url: string; signature: string }> = {};
  for (const platform of platforms) {
    const url = new URL(platform.url);
    if (
      !/^(darwin|windows|linux)-(aarch64|x86_64)(?:-(?:nsis|msi|appimage))?$/.test(
        platform.target,
      ) ||
      values[platform.target]
    )
      throw new Error("Invalid or duplicate native platform");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !platform.signature.trim()
    )
      throw new Error("Expected signed artifact and credential-free HTTPS URL");
    values[platform.target] = {
      url: platform.url,
      signature: platform.signature.trim(),
    };
  }
  if (!platforms.length)
    throw new Error("At least one signed native artifact is required");
  return { version, distribution, platforms: values };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      target: { type: "string", multiple: true },
      url: { type: "string", multiple: true },
      signature: { type: "string", multiple: true },
      output: { type: "string" },
    },
  });
  if (
    !values.version ||
    !values.output ||
    values.target?.length !== values.url?.length ||
    values.target?.length !== values.signature?.length
  )
    throw new Error(
      "Provide --version --output and matching --target --url --signature-file lists (--signature names a file)",
    );
  const platforms = await Promise.all(
    (values.target ?? []).map(async (target, index) => ({
      target,
      url: values.url?.[index] ?? "",
      signature: await readFile(values.signature?.[index] ?? "", "utf8"),
    })),
  );
  const result = shellUpdateManifest(
    values.version,
    platforms,
    shellDistribution(process.env),
  );
  await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
}

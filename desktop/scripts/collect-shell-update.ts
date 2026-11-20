import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  shellDistribution,
  shellUpdateManifest,
} from "./shell-update-manifest";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const bundle = join(desktop, "src-tauri/target/release/bundle");
const output = join(desktop, "dist/shell-updates");
const base = process.env.OPENBOT_SHELL_ASSET_BASE_URL;
if (!base)
  throw new Error(
    "OPENBOT_SHELL_ASSET_BASE_URL must identify the reviewed future artifact destination",
  );
const version = (await Bun.file(join(desktop, "../package.json")).json())
  .version;
const signatures = await Array.fromAsync(
  new Bun.Glob("**/*.sig").scan({ cwd: bundle, onlyFiles: true }),
);
if (signatures.length !== 1)
  throw new Error(
    `Expected one signed updater bundle for the selected platform; found ${signatures.length}`,
  );
const signaturePath = join(bundle, signatures[0] ?? "");
const artifact = signaturePath.slice(0, -4);
if (!(await stat(artifact)).isFile())
  throw new Error("Signed updater artifact is absent");
const platforms: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "darwin",
  win32: "windows",
  linux: "linux",
};
const os = platforms[process.platform];
if (!os || !["arm64", "x64"].includes(process.arch))
  throw new Error("Unsupported native updater build platform");
const target = `${os}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
const url = `${base.replace(/\/$/, "")}/${encodeURIComponent(basename(artifact))}`;
const manifest = shellUpdateManifest(
  version,
  [{ target, url, signature: await readFile(signaturePath, "utf8") }],
  shellDistribution(process.env),
);
await mkdir(output, { recursive: true });
await copyFile(artifact, join(output, basename(artifact)));
await copyFile(signaturePath, join(output, basename(signaturePath)));
await writeFile(
  join(output, `fragment-${target}.json`),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { flag: "wx" },
);

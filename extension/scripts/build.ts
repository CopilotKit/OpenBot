import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, type InlineConfig } from "vite";
import { type BuildVariant, buildManifest } from "../src/manifest";
import { verifyDist } from "./verify-dist";

const PAGES = ["popup", "connect", "setup", "options"] as const;

export function parseBuildVariant(
  value: string | undefined,
): BuildVariant | null {
  if (value === undefined || value === "" || value === "release")
    return "release";
  if (value === "e2e") return "e2e";
  return null;
}

export function viteConfigs(input: {
  variant: BuildVariant;
  root: string;
}): InlineConfig[] {
  const { variant, root } = input;
  const source = path.join(root, "extension", "src");
  const outDir = path.join(root, "extension", "dist");
  const shared = {
    configFile: false,
    root: source,
    publicDir: false,
    define: {
      "import.meta.env.RECORDER_VARIANT": JSON.stringify(variant),
    },
    resolve: { alias: { "@": path.join(root, "app", "src") } },
  } satisfies InlineConfig;
  const script = (entry: string, name: string, file: string): InlineConfig => ({
    ...shared,
    define: {
      ...shared.define,
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    build: {
      outDir,
      emptyOutDir: false,
      sourcemap: false,
      lib: {
        entry: path.join(source, entry),
        formats: ["iife"],
        name,
        fileName: () => file,
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  return [
    {
      ...shared,
      base: "./",
      plugins: [react(), tailwindcss()],
      build: {
        outDir,
        emptyOutDir: true,
        sourcemap: false,
        rollupOptions: {
          input: {
            ...Object.fromEntries(
              PAGES.map((name) => [
                name,
                path.join(source, `pages/${name}/index.html`),
              ]),
            ),
            offscreen: path.join(source, "offscreen/offscreen.html"),
            "service-worker": path.join(source, "background/index.ts"),
          },
          output: {
            entryFileNames: (chunk) =>
              chunk.name === "service-worker"
                ? "service-worker.js"
                : "assets/[name]-[hash].js",
          },
        },
      },
    },
    script("content/index.ts", "OpenBotRecorderContent", "content.js"),
    script(
      "main-world/network-hook.ts",
      "OpenBotRecorderPageNetwork",
      "page-network.js",
    ),
  ];
}

// Vite writes each page at its source path; the manifest names them at the root of dist.
function moveHtml(dist: string, from: string, to: string) {
  const source = path.join(dist, from);
  const html = readFileSync(source, "utf8").replace(
    /(?:\.\.\/)+assets\//g,
    "./assets/",
  );
  writeFileSync(path.join(dist, to), html);
  rmSync(source);
}

async function main() {
  const root = path.resolve(import.meta.dir, "..", "..");
  const extension = path.join(root, "extension");
  const dist = path.join(extension, "dist");
  const requested = process.env.RECORDER_BUILD_VARIANT;
  const variant = parseBuildVariant(requested);
  if (variant === null) {
    console.error(
      `RECORDER_BUILD_VARIANT must be "release" or "e2e", got "${requested}"`,
    );
    process.exit(1);
  }

  for (const config of viteConfigs({ variant, root })) await build(config);

  for (const name of PAGES)
    moveHtml(dist, `pages/${name}/index.html`, `${name}.html`);
  moveHtml(dist, "offscreen/offscreen.html", "offscreen.html");
  rmSync(path.join(dist, "pages"), { recursive: true, force: true });
  rmSync(path.join(dist, "offscreen"), { recursive: true, force: true });

  mkdirSync(dist, { recursive: true });
  cpSync(path.join(extension, "public"), dist, { recursive: true });

  const rootVersion = (
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  const publicKey = readFileSync(
    path.join(extension, "keys", "public-key.txt"),
    "utf8",
  ).trim();
  writeFileSync(
    path.join(dist, "manifest.json"),
    `${JSON.stringify(buildManifest({ version: rootVersion, publicKey }), null, 2)}\n`,
  );

  const problems = verifyDist(dist, { variant, rootVersion });
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
}

if (import.meta.main) await main();

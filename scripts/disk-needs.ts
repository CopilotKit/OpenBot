#!/usr/bin/env bun
/**
 * How much disk OpenBot Desktop needs and uses, and whether the numbers the window says still hold.
 *
 * The window says rough numbers (desktop/src/disk-needs.json): about 20 GB free to install, 7 to 10
 * GB once installed, and about 20 GB free to update. They were measured on one Mac on 2026-11-19,
 * and every release changes OpenBot's images. This reads a release's images and fails when one of
 * those numbers no longer holds, saying which and what it should be.
 *
 *   bun scripts/disk-needs.ts [--release <tag>] [--updates <n>]
 *     The release (default: the newest one, candidates included) and the <n> releases before it
 *     (default 4). Each image the release's `desktop-images.json` names is read from its registry,
 *     linux/arm64 and linux/amd64, the larger counting. Run by .github/workflows/disk-needs.yml for
 *     every release that is published.
 *
 *   bun scripts/disk-needs.ts --measure [--release <tag>]
 *     On a computer running OpenBot Desktop: what OpenBot's images and its back end take on disk
 *     there, against what they download, which is `onDisk` in disk-needs.json. Run it after a
 *     release that changes how images are stored, and put what it prints in the file.
 *
 * What it counts. An installation pulls OpenBot's server and computer image, its database, the Bot
 * framework that runs its Bots and, for a Claude or ChatGPT plan, the image that signs in to it
 * (`desktop/src-tauri/src/plan.rs`), and the back end the Intelligence CLI installs: its k3s node
 * and the images inside that node. A blob two images share counts once. Containerd keeps each
 * image's download beside its unpacked layers, so an image takes `onDisk` times its download; an
 * update downloads only the blobs the release before it did not have, and holds them beside the
 * running release until it starts.
 *
 * Env: GITHUB_REPOSITORY (default CopilotKit/OpenBot), GH_TOKEN for GitHub's API when it is set.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const GIB = 1024 ** 3;
const MB = 1_000_000;

/** desktop/src/disk-needs.json: what the window says, in GB of 2^30 bytes, and the factors. */
export type DiskNeeds = {
  installFreeGb: number;
  installedGb: { from: number; to: number };
  updateFreeGb: number;
  backEndFreeGb: number;
  imagesDownloadMb: number;
  mostAnUpdateDownloadsMb: number;
  onDisk: number;
};

/** A release's `desktop-images.json`: every image the app may pull for it. */
export type ImageList = {
  openbot?: string;
  intelligence?: string;
  images: string[];
};

/** One blob of an image, by digest, with its download size. */
export type Blob = { digest: string; size: number };

/** What each image reference downloads: its config and layers. */
export type Sizes = Map<string, Blob[]>;

/**
 * Logs kept at most, beside the images: Docker's `local` driver keeps 100 MB a container, k3s 50
 * MiB a container (`containerLogMaxSize` 10Mi times 5). About 1.3 GiB for OpenBot's containers and
 * the back end's, as measured on 2026-11-19.
 */
export const LOGS_BYTES = 1.3 * GIB;

/** How much the low end of "7 to 10 GB" may sit above the smallest installation. */
const LOW_END_SLACK = 1.5 * GIB;

/** How far over `imagesDownloadMb` OpenBot's downloads may go before the estimate is stale. */
const DOWNLOAD_SLACK = 1.1;

/** Which part of an installation pulls an image. */
export type Part =
  | "openbot"
  | "framework"
  | "sign-in"
  | "back-end"
  | "machine"
  | "other";

/** The image's repository, without its registry or its tag or digest. */
export function repository(ref: string): string {
  const [first, ...rest] = ref.split("/");
  const path =
    first.includes(".") || first.includes(":") ? rest.join("/") : ref;
  return path.split("@")[0].replace(/:[^/]*$/, "");
}

/** The framework images that sign in to a Claude or a ChatGPT plan (`plan.rs`). */
const SIGN_IN = new Set([
  "copilotkit/openbot-agent-claude-sdk",
  "copilotkit/openbot-agent-langgraph-agui",
]);

/** What `ref` is to an installation. */
export function partOf(ref: string): Part {
  const repo = repository(ref);
  if (
    repo === "copilotkit/openbot" ||
    repo === "copilotkit/openbot-server" ||
    repo === "pgvector/pgvector"
  ) {
    return "openbot";
  }
  if (repo.startsWith("copilotkit/openbot-agent-")) {
    return SIGN_IN.has(repo) ? "sign-in" : "framework";
  }
  // The CLI's k3s node and its tools on the engine (it runs no k3d load balancer), and everything
  // it loads into the node.
  if (repo === "rancher/k3s" || repo === "k3d-io/k3d-tools") return "back-end";
  if (
    repo.startsWith("copilotkit/intelligence/") ||
    repo === "bitnamilegacy/redis" ||
    repo.startsWith("rancher/")
  ) {
    return "back-end";
  }
  if (repo === "podman/machine-os") return "machine";
  return "other";
}

/** The download size of `refs` together, a blob two of them share counted once. */
export function downloadBytes(refs: string[], sizes: Sizes): number {
  const blobs = new Map<string, number>();
  for (const ref of refs) {
    for (const blob of sizes.get(ref) ?? []) blobs.set(blob.digest, blob.size);
  }
  return [...blobs.values()].reduce((sum, size) => sum + size, 0);
}

/** The digests `refs` download. */
function digests(refs: string[], sizes: Sizes): Set<string> {
  return new Set(
    refs.flatMap((ref) => (sizes.get(ref) ?? []).map((blob) => blob.digest)),
  );
}

/**
 * What an installation of `list` pulls, by framework: OpenBot's own images, the back end's, and the
 * framework, with no sign-in image at the smallest and both at the largest.
 */
export function installations(list: ImageList, sizes: Sizes) {
  const of = (part: Part) => list.images.filter((ref) => partOf(ref) === part);
  const openbot = of("openbot");
  const backEnd = of("back-end");
  const signIn = of("sign-in");
  const frameworks = of("framework");
  const options = (frameworks.length > 0 ? frameworks : [undefined]).map(
    (framework) => [...openbot, ...backEnd, ...(framework ? [framework] : [])],
  );
  const sized = options.map((refs) => ({
    refs,
    bytes: downloadBytes(refs, sizes),
  }));
  sized.sort((a, b) => a.bytes - b.bytes);
  const smallest = sized[0];
  const largest = sized[sized.length - 1];
  return {
    openbot,
    backEnd,
    signIn,
    smallest: smallest.refs,
    largest: [...largest.refs, ...signIn],
    /** Everything an update can download: OpenBot's, the back end's, and the frameworks it runs. */
    everything: [...openbot, ...backEnd, ...signIn],
  };
}

/** One release's figures, in bytes. */
export type Figures = {
  release: string;
  installedSmallest: number;
  installedLargest: number;
  backEndInstalled: number;
  openbotDownload: number;
  everythingDownload: number;
  /** The largest update to this release from one of the releases before it, and from which. */
  largestUpdate: number;
  largestUpdateFrom?: string;
};

/**
 * The figures for `list`, with `earlier` the releases before it, newest first, for the size of an
 * update: what is new in each step, held on disk beside the release it replaces.
 */
export function figures(
  release: string,
  list: ImageList,
  earlier: { release: string; list: ImageList }[],
  sizes: Sizes,
  needs: DiskNeeds,
): Figures {
  const now = installations(list, sizes);
  let largestUpdate = 0;
  let largestUpdateFrom: string | undefined;
  const steps = [{ release, list }, ...earlier];
  for (let at = 0; at + 1 < steps.length; at++) {
    const to = installations(steps[at].list, sizes).everything;
    const from = digests(
      installations(steps[at + 1].list, sizes).everything,
      sizes,
    );
    const blobs = new Map<string, number>();
    for (const ref of to) {
      for (const blob of sizes.get(ref) ?? []) {
        if (!from.has(blob.digest)) blobs.set(blob.digest, blob.size);
      }
    }
    const bytes =
      [...blobs.values()].reduce((sum, size) => sum + size, 0) * needs.onDisk;
    if (bytes > largestUpdate) {
      largestUpdate = bytes;
      largestUpdateFrom = `${steps[at + 1].release} to ${steps[at].release}`;
    }
  }
  return {
    release,
    installedSmallest: downloadBytes(now.smallest, sizes) * needs.onDisk,
    installedLargest: downloadBytes(now.largest, sizes) * needs.onDisk,
    backEndInstalled: downloadBytes(now.backEnd, sizes) * needs.onDisk,
    openbotDownload: downloadBytes([...now.openbot, ...now.signIn], sizes),
    everythingDownload: downloadBytes(now.everything, sizes),
    largestUpdate,
    largestUpdateFrom,
  };
}

/** A number the window says, checked: whether it holds, and what it should be when it does not. */
export type Check = {
  name: string;
  holds: boolean;
  said: string;
  measured: string;
  fix?: string;
};

const gb = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;
const mb = (bytes: number) => `${Math.round(bytes / MB)} MB`;

/** Each of `needs`'s numbers against `f`. */
export function checks(f: Figures, needs: DiskNeeds): Check[] {
  const room = f.installedLargest + f.largestUpdate + LOGS_BYTES;
  const backEndRoom = f.backEndInstalled + f.largestUpdate + LOGS_BYTES;
  return [
    {
      name: "installedGb.to",
      holds: f.installedLargest <= needs.installedGb.to * GIB,
      said: `up to ${needs.installedGb.to} GB installed`,
      measured: `${gb(f.installedLargest)} with the largest framework and both sign-in images`,
      fix: `"to": ${Math.ceil(f.installedLargest / GIB)}`,
    },
    {
      name: "installedGb.from",
      holds:
        needs.installedGb.from * GIB <= f.installedSmallest + LOW_END_SLACK,
      said: `from ${needs.installedGb.from} GB installed`,
      measured: `${gb(f.installedSmallest)} with the smallest framework`,
      fix: `"from": ${Math.floor(f.installedSmallest / GIB)}`,
    },
    {
      name: "installFreeGb",
      holds: room <= needs.installFreeGb * GIB,
      said: `about ${needs.installFreeGb} GB free to install`,
      measured: `${gb(room)}: installed, the largest update beside it, and logs`,
      fix: `"installFreeGb": ${Math.ceil(room / GIB)}`,
    },
    {
      name: "backEndFreeGb",
      holds: backEndRoom <= needs.backEndFreeGb * GIB,
      said: `${needs.backEndFreeGb} GB free for the back end's setup`,
      measured: `${gb(backEndRoom)}: the back end installed, the largest update beside it, and logs`,
      fix: `"backEndFreeGb": ${Math.ceil(backEndRoom / GIB)}, and the CLI's REQUIRED_DISK_GIB with it`,
    },
    {
      name: "imagesDownloadMb",
      holds: f.openbotDownload <= needs.imagesDownloadMb * MB * DOWNLOAD_SLACK,
      said: `about ${needs.imagesDownloadMb} MB of OpenBot's own downloads`,
      measured: mb(f.openbotDownload),
      fix: `"imagesDownloadMb": ${Math.ceil(f.openbotDownload / MB / 100) * 100}`,
    },
    {
      name: "mostAnUpdateDownloadsMb",
      holds: f.everythingDownload <= needs.mostAnUpdateDownloadsMb * MB,
      said: `an update downloads at most ${needs.mostAnUpdateDownloadsMb} MB`,
      measured: `${mb(f.everythingDownload)} with every image changed`,
      fix: `"mostAnUpdateDownloadsMb": ${Math.ceil(f.everythingDownload / MB / 100) * 100}`,
    },
  ];
}

/** Fetches JSON, for the registries and GitHub. A test hands in its own. */
export type Fetch = (
  url: string,
  headers?: Record<string, string>,
) => Promise<unknown>;

const realFetch: Fetch = async (url, headers) => {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
};

const MANIFESTS = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

type Manifest = {
  manifests?: {
    digest: string;
    platform?: { os?: string; architecture?: string };
  }[];
  config?: Blob;
  layers?: Blob[];
};

/** The registry, repository and reference of `ref`, a Docker Hub short name included. */
function located(ref: string): {
  host: string;
  repo: string;
  reference: string;
} {
  const first = ref.split("/")[0];
  const full =
    ref.includes("/") && (first.includes(".") || first.includes(":"))
      ? ref
      : `docker.io/${ref.includes("/") ? ref : `library/${ref}`}`;
  const [host, ...rest] = full.split("/");
  const path = rest.join("/");
  const at = path.indexOf("@");
  const [repo, reference] =
    at >= 0
      ? [path.slice(0, at), path.slice(at + 1)]
      : [path.replace(/:[^/:]*$/, ""), path.slice(path.lastIndexOf(":") + 1)];
  return {
    host: host === "docker.io" ? "registry-1.docker.io" : host,
    repo,
    reference,
  };
}

/** An anonymous pull token for `repo` on `host`. */
async function token(host: string, repo: string, get: Fetch): Promise<string> {
  const url =
    host === "registry-1.docker.io"
      ? `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`
      : host === "quay.io"
        ? `https://quay.io/v2/auth?service=quay.io&scope=repository:${repo}:pull`
        : `https://${host}/token?scope=repository:${repo}:pull`;
  const answer = (await get(url)) as { token?: string };
  return answer.token ?? "";
}

/** The blobs `ref` downloads on linux/arm64 and on linux/amd64, whichever is larger. */
export async function blobsOf(
  ref: string,
  get: Fetch = realFetch,
): Promise<Blob[]> {
  const { host, repo, reference } = located(ref);
  const auth = {
    Authorization: `Bearer ${await token(host, repo, get)}`,
    Accept: MANIFESTS,
  };
  const manifest = (url: string) => get(url, auth) as Promise<Manifest>;
  const base = `https://${host}/v2/${repo}/manifests/`;
  const top = await manifest(base + reference);
  const images = top.manifests
    ? await Promise.all(
        top.manifests
          .filter(
            (entry) =>
              entry.platform?.os === "linux" &&
              (entry.platform.architecture === "arm64" ||
                entry.platform.architecture === "amd64"),
          )
          .map((entry) => manifest(base + entry.digest)),
      )
    : [top];
  const each = images.map((image) => [
    ...(image.config
      ? [{ digest: image.config.digest, size: image.config.size }]
      : []),
    ...(image.layers ?? []).map((layer) => ({
      digest: layer.digest,
      size: layer.size,
    })),
  ]);
  const total = (blobs: Blob[]) =>
    blobs.reduce((sum, blob) => sum + blob.size, 0);
  return each.sort((a, b) => total(b) - total(a))[0] ?? [];
}

/** The sizes of every image in `lists`, read once each. */
export async function sizesOf(
  lists: ImageList[],
  get: Fetch = realFetch,
): Promise<Sizes> {
  const refs = [...new Set(lists.flatMap((list) => list.images))].filter(
    (ref) => partOf(ref) !== "other",
  );
  const sizes: Sizes = new Map();
  for (const ref of refs) sizes.set(ref, await blobsOf(ref, get));
  return sizes;
}

const repoName = () => process.env.GITHUB_REPOSITORY ?? "CopilotKit/OpenBot";

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (process.env.GH_TOKEN)
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  return headers;
}

/** The releases that carry an image list, newest first. */
async function releases(get: Fetch): Promise<string[]> {
  const listed = (await get(
    `https://api.github.com/repos/${repoName()}/releases?per_page=40`,
    githubHeaders(),
  )) as {
    tag_name: string;
    draft: boolean;
    assets: { name: string }[];
  }[];
  return listed
    .filter(
      (release) =>
        !release.draft &&
        release.assets.some((asset) => asset.name === "desktop-images.json"),
    )
    .map((release) => release.tag_name);
}

/** A release's image list, asked again a few times while a release just published settles. */
async function imageList(tag: string): Promise<ImageList> {
  const url = `https://github.com/${repoName()}/releases/download/${tag}/desktop-images.json`;
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url);
    if (response.ok) return (await response.json()) as ImageList;
    if (attempt === 3)
      throw new Error(`${tag}'s desktop-images.json: ${response.status}`);
    await Bun.sleep(20_000);
  }
}

/** desktop/src/disk-needs.json. */
export function readNeeds(root = join(import.meta.dir, "..")): DiskNeeds {
  return JSON.parse(
    readFileSync(join(root, "desktop/src/disk-needs.json"), "utf8"),
  ) as DiskNeeds;
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/** The release check: prints the figures and each number, and answers 1 when one does not hold. */
async function check(args: string[]): Promise<number> {
  const needs = readNeeds();
  const tags = await releases(realFetch);
  const release = option(args, "--release") || tags[0];
  if (!release) throw new Error("no release carries a desktop-images.json");
  const count = Number(option(args, "--updates") ?? 4);
  const before = tags.slice(
    tags.indexOf(release) + 1,
    tags.indexOf(release) + 1 + count,
  );
  const list = await imageList(release);
  const earlier = await Promise.all(
    before.map(async (tag) => ({ release: tag, list: await imageList(tag) })),
  );
  const sizes = await sizesOf([list, ...earlier.map((step) => step.list)]);
  const f = figures(release, list, earlier, sizes, needs);
  console.log(
    `OpenBot Desktop ${release}, with back end ${list.intelligence ?? "unknown"}, at ${needs.onDisk}x on disk:`,
  );
  console.log(
    `  installed:           ${gb(f.installedSmallest)} to ${gb(f.installedLargest)}`,
  );
  console.log(`  back end installed:  ${gb(f.backEndInstalled)}`);
  console.log(
    `  largest update:      ${gb(f.largestUpdate)}${f.largestUpdateFrom ? ` (${f.largestUpdateFrom})` : ""}`,
  );
  console.log(
    `  OpenBot's downloads: ${mb(f.openbotDownload)}; everything: ${mb(f.everythingDownload)}`,
  );
  let failed = 0;
  for (const c of checks(f, needs)) {
    console.log(
      `${c.holds ? "holds  " : "STALE  "} ${c.name}: says ${c.said}; measured ${c.measured}`,
    );
    if (!c.holds) {
      failed++;
      console.log(`        change desktop/src/disk-needs.json: ${c.fix}`);
    }
  }
  if (failed > 0) {
    console.log(
      `${failed} of the window's disk numbers no longer hold for ${release}. Change them in desktop/src/disk-needs.json; the Rust tests then name the constants to change with them.`,
    );
  }
  return failed > 0 ? 1 : 0;
}

/** `command args` on this computer, its output. */
function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The live measurement: OpenBot's images and the back end on disk here, against their downloads. */
async function measure(args: string[]): Promise<number> {
  const deployment = JSON.parse(
    readFileSync(
      join(process.env.HOME ?? "", "OpenBot/.openbot-deployment"),
      "utf8",
    ),
  ) as { version: string };
  const release = option(args, "--release") || deployment.version;
  const list = await imageList(release);
  const sizes = await sizesOf([list]);
  // OpenBot's images on the engine: each one's size there, which is its layers and its download.
  let onDiskBytes = 0;
  let downloadedRefs: string[] = [];
  for (const ref of list.images.filter(
    (image) =>
      ["openbot", "framework", "sign-in"].includes(partOf(image)) ||
      ["rancher/k3s", "k3d-io/k3d-tools"].includes(repository(image)),
  )) {
    try {
      onDiskBytes += Number(
        run("docker", [
          "image",
          "inspect",
          "--format",
          "{{.Size}}",
          ref,
        ]).trim(),
      );
      downloadedRefs = [...downloadedRefs, ref];
    } catch {
      // Not pulled here: a framework this installation does not run.
    }
  }
  // The back end's node: what containerd keeps there, downloads and layers, and its data.
  const node = run("docker", ["ps", "--format", "{{.Names}}"])
    .split("\n")
    .find((name) => /^k3d-.*-server-0$/.test(name));
  let nodeBytes = 0;
  let nodeDownload = 0;
  if (node) {
    const du = run("docker", [
      "exec",
      node,
      "du",
      "-sk",
      "/var/lib/rancher/k3s/agent/containerd/io.containerd.content.v1.content",
      "/var/lib/rancher/k3s/agent/containerd/io.containerd.snapshotter.v1.overlayfs",
    ]);
    nodeBytes = du
      .trim()
      .split("\n")
      .reduce((sum, line) => sum + Number(line.split(/\s+/)[0]) * 1024, 0);
    const images = JSON.parse(
      run("docker", ["exec", node, "crictl", "images", "-o", "json"]),
    ) as {
      images: { size: string }[];
    };
    nodeDownload = images.images.reduce(
      (sum, image) => sum + Number(image.size),
      0,
    );
  }
  const download = downloadBytes(downloadedRefs, sizes) + nodeDownload;
  const onDisk = onDiskBytes + nodeBytes;
  console.log(`OpenBot Desktop ${release} on this computer:`);
  console.log(
    `  images on the engine: ${gb(onDiskBytes)} for ${mb(downloadBytes(downloadedRefs, sizes))} downloaded`,
  );
  console.log(
    `  the back end's node:  ${gb(nodeBytes)} for ${mb(nodeDownload)} downloaded${node ? "" : " (no node running)"}`,
  );
  console.log(
    `  on disk per byte downloaded: ${(onDisk / download).toFixed(2)} ("onDisk" in desktop/src/disk-needs.json)`,
  );
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  process.exit(
    await (args.includes("--measure") ? measure(args) : check(args)),
  );
}

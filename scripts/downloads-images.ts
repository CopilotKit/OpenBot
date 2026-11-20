#!/usr/bin/env bun
/**
 * Copies every container image the Desktop app downloads for a release from GitHub's container
 * registry to downloads.copilotkit.ai, which the app tries first (docs/releasing.md).
 *
 * Run by .github/workflows/downloads-sync.yml after scripts/downloads-sync.sh, for the same
 * release, and by hand. The release's `desktop-images.json` says which images: the Desktop app's
 * own code writes it when the release is published (desktop/src-tauri/src/release_images.rs), so
 * it names exactly what the app pulls. Images on ghcr.io, Docker Hub and quay.io are copied; any other
 * registry is left as it is. quay.io holds the engine machine images Podman builds its machine from,
 * which the app downloads before Install (desktop/src-tauri/src/early_downloads.rs).
 *
 * What it writes, in the bucket behind the CloudFront distribution: a read-only copy of the
 * registry's own paths (the OCI Distribution API, GET only), so the address works as a registry:
 *   v2/                                  `{}`, so a client's first request answers
 *   v2/<repo>/manifests/<tag>            the bytes ghcr.io serves for the tag, typed by their
 *                                        mediaType; cached for five minutes, invalidated here
 *   v2/<repo>/manifests/sha256:<hex>     each index and every manifest it names, every platform and
 *                                        every attestation, byte for byte, so its digest is the same;
 *                                        cached a year
 *   v2/<repo>/blobs/sha256:<hex>         each config and layer of those; cached a year
 *   v2/<repo>/referrers/sha256:<hex>     an empty image index for each of those manifests, so the
 *                                        referrers API Docker 29 asks with every pull answers 200;
 *                                        cached for five minutes
 * <repo> is the path on ghcr.io unchanged, such as copilotkit/openbot-server, for Docker Hub
 * docker.io/ and its path, official images under library/ (docker.io/library/busybox), and for
 * quay.io quay.io/ and its path (quay.io/podman/machine-os). The whole
 * index is copied because Docker 29 fetches every manifest it names, attestations included, and a
 * 403 for one fails the pull. An image named by digest whose referrers are there already is whole,
 * and is not read again.
 *
 * Running it again changes nothing. Each object S3 holds is compared by the SHA-256 S3 computed on
 * upload, its Content-Type and its Cache-Control, and only what is missing or differs is read from
 * ghcr.io and uploaded. Every byte is checked against its digest before it is uploaded, and S3
 * refuses an upload whose bytes do not hash to the checksum sent with it. Blobs go first, then the
 * manifests that name them, then the tags, so nothing points at what is not there yet. Nothing is
 * ever deleted. Afterwards each new object is fetched once through the address, so CloudFront's
 * Origin Shield holds it before anyone installs.
 *
 * Env:
 *   GITHUB_REPOSITORY and GH_TOKEN  for `gh`
 *   DOWNLOADS_BUCKET                the bucket behind the distribution
 *   DOWNLOADS_DISTRIBUTION_ID       the CloudFront distribution
 *   DOWNLOADS_TAG                   copy this release's images, a candidate or beta included (default:
 *                                   the Latest release, and every prerelease newer than it from
 *                                   the last 30 days)
 *   DOWNLOADS_IMAGES_FILE           copy the images this list names instead of a release's, for a
 *                                   release published before it carried one
 *   DOWNLOADS_PREFIX                put every key under this prefix, such as `smoketest/`
 *   DOWNLOADS_URL                   the address to warm (default https://downloads.copilotkit.ai)
 *   DOWNLOADS_PARALLEL              how many reads, uploads and fetches at once (default 8)
 *   and AWS credentials that may read and write the bucket and invalidate the distribution, and
 *   `crane` (go-containerregistry) on PATH.
 */
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TAG_CACHE = "public, max-age=300";
export const IMMUTABLE = "public, max-age=31536000, immutable";
export const LIST = "desktop-images.json";
export const PINS = "container-images.json";

const INDEX_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const MANIFEST_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const MANIFEST_ACCEPT = [...INDEX_TYPES, ...MANIFEST_TYPES].join(", ");
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
/** What `v2/<repo>/referrers/<digest>` answers: an empty image index, which says nothing refers to it. */
export const EMPTY_REFERRERS = new TextEncoder().encode(
  `{"schemaVersion":2,"mediaType":"${OCI_INDEX}","manifests":[]}`,
);

const repoPattern =
  /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const tagPattern = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

export type Ref = {
  /** How the image is named in messages: its registry and repository. */
  name: string;
  /** Its folder under v2/: the ghcr.io path, or docker.io/ and the Docker Hub path. */
  path: string;
  /** What crane reads it as. */
  read: string;
  tag?: string;
  digest?: string;
};

const DOCKER_HUB = new Set([
  "docker.io",
  "index.docker.io",
  "registry-1.docker.io",
]);

/**
 * An image reference on ghcr.io or Docker Hub, or `undefined` for one on any other registry. A
 * reference whose first part is not a host (no dot, no port, not localhost) is Docker Hub's, as
 * Compose prints `pgvector/pgvector:pg17`, and a Docker Hub name of one part is an official image,
 * `library/<name>`. Pinned by digest when it has one. `source` stands in for ghcr.io.
 */
export function imageRef(
  reference: string,
  source = "ghcr.io",
): Ref | undefined {
  const slash = reference.indexOf("/");
  const first = slash === -1 ? "" : reference.slice(0, slash);
  const hosted =
    first.includes(".") || first.includes(":") || first === "localhost";
  const host = hosted ? first : "docker.io";
  if (host !== "ghcr.io" && host !== "quay.io" && !DOCKER_HUB.has(host))
    return undefined;
  let rest = hosted ? reference.slice(slash + 1) : reference;
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon !== -1) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (
    !repoPattern.test(rest) ||
    (digest !== undefined && !digestPattern.test(digest)) ||
    (tag !== undefined && !tagPattern.test(tag)) ||
    (digest === undefined && tag === undefined)
  ) {
    throw new Error(`${reference} is not an image reference this can copy.`);
  }
  const where =
    host === "ghcr.io"
      ? { name: `ghcr.io/${rest}`, path: rest, read: `${source}/${rest}` }
      : host === "quay.io"
        ? {
            name: `quay.io/${rest}`,
            path: `quay.io/${rest}`,
            read: `quay.io/${rest}`,
          }
        : (() => {
            const repo = rest.includes("/") ? rest : `library/${rest}`;
            return {
              name: `docker.io/${repo}`,
              path: `docker.io/${repo}`,
              read: `docker.io/${repo}`,
            };
          })();
  // A digest names the image exactly; a tag beside it is only a label, as it is to a client.
  return digest ? { ...where, digest } : { ...where, tag };
}

type Planned = {
  key: string;
  kind: "file" | "blob" | "manifest" | "index" | "referrers" | "tag" | "ping";
  /** A file already downloaded, or where to download one from github.com. */
  path?: string;
  url?: string;
  sha256: string;
  contentType: string;
  cache: string;
  /** The bytes, for a manifest; a blob is read from ghcr.io only when it is uploaded. */
  bytes?: Uint8Array;
  /** Where a blob is read from, and its size. */
  source?: string;
  size?: number;
};

class Failure extends Error {}

function fail(message: string): never {
  throw new Failure(message);
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function fileSha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of createReadStream(path)) hasher.update(chunk);
  return hasher.digest("hex");
}

type Run = { code: number; stdout: Uint8Array; stderr: string };

async function run(
  args: string[],
  options: { stdout?: string } = {},
): Promise<Run> {
  const child = Bun.spawn(args, {
    stdin: "ignore",
    stdout: options.stdout ? Bun.file(options.stdout) : "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    options.stdout
      ? Promise.resolve(new Uint8Array())
      : new Response(child.stdout as ReadableStream).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/** Runs `work` on every item, at most `limit` at once, and stops at the first failure. */
async function pool<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed: unknown;
  const worker = async () => {
    while (failed === undefined && next < items.length) {
      const item = items[next++] as T;
      try {
        await work(item);
      } catch (error) {
        failed ??= error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  if (failed !== undefined) throw failed;
}

type Env = Record<string, string | undefined>;

export async function main(env: Env = process.env): Promise<number> {
  // Only checks that every image answers through the address: no AWS, no registry.
  const verifyOnly = env.DOWNLOADS_VERIFY_ONLY === "1";
  const bucket =
    env.DOWNLOADS_BUCKET ||
    (verifyOnly ? "" : fail("DOWNLOADS_BUCKET must name the bucket."));
  const distribution =
    env.DOWNLOADS_DISTRIBUTION_ID ||
    (verifyOnly
      ? ""
      : fail(
          "DOWNLOADS_DISTRIBUTION_ID must name the CloudFront distribution.",
        ));
  const prefix = env.DOWNLOADS_PREFIX ?? "";
  if (prefix && !/^[a-z0-9][a-z0-9-]*\/$/.test(prefix)) {
    fail(
      "DOWNLOADS_PREFIX must be a single lowercase folder ending in /, such as smoketest/.",
    );
  }
  const address = (
    env.DOWNLOADS_URL || "https://downloads.copilotkit.ai"
  ).replace(/\/+$/, "");
  const parallel = Number(env.DOWNLOADS_PARALLEL || "8");
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 64) {
    fail("DOWNLOADS_PARALLEL must be a whole number from 1 to 64.");
  }
  // Only the tests read from another registry, standing in for ghcr.io under the same paths.
  const source = env.DOWNLOADS_IMAGES_SOURCE || "ghcr.io";
  const github = (env.DOWNLOADS_GITHUB_URL || "https://github.com").replace(
    /\/+$/,
    "",
  );
  const work = mkdtempSync(
    join(env.RUNNER_TEMP || tmpdir(), "downloads-images-"),
  );
  try {
    for (const tag of await releasesToCopy(env)) {
      const listed = await readList(env, work, tag);
      if (verifyOnly) {
        const refs = listed.images.flatMap(
          (image) => imageRef(image, source) ?? [],
        );
        await verify(refs, {
          address,
          prefix,
          parallel,
          env,
          label: listed.label,
        });
        continue;
      }
      const files = await releaseFiles(listed.tag, env, github, work, prefix);
      await copy({
        ...listed,
        files,
        bucket,
        distribution,
        prefix,
        address,
        parallel,
        source,
        work,
        env,
      });
    }
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * What the app downloads from github.com for a release besides its assets, each into the bucket
 * under a fixed key: the release's source archive, which a deployment is laid out from
 * (desktop/src-tauri/src/deployment.rs), and the Podman installers and Compose binaries Install
 * puts on a machine without an engine, at the versions and digests that release's
 * desktop/src-tauri/src/install.rs pins, every platform. Read from the archive itself, so they are
 * the release's pins and not main's. Each tool is checked against its pin before it is uploaded.
 */
async function releaseFiles(
  tag: string,
  env: Env,
  github: string,
  work: string,
  prefix: string,
): Promise<Planned[]> {
  const repository = env.GITHUB_REPOSITORY as string;
  const archive = join(work, `${tag}.tar.gz`);
  const url = `${github}/${repository}/archive/refs/tags/${tag}.tar.gz`;
  const answer = await fetch(url);
  if (!answer.ok) fail(`Could not download ${url}: ${answer.status}`);
  await Bun.write(archive, answer);
  // GitHub puts everything under one folder named for the repository and the version.
  const listing = await run(["tar", "-tzf", archive]);
  const top = new TextDecoder()
    .decode(listing.stdout)
    .split("\n")[0]
    ?.split("/")[0];
  if (listing.code !== 0 || !top)
    fail(`${url} is not a source archive: ${listing.stderr.trim()}`);
  const read = await run([
    "tar",
    "-xzOf",
    archive,
    `${top}/desktop/src-tauri/src/install.rs`,
  ]);
  const pins = new TextDecoder().decode(read.stdout);
  if (read.code !== 0 || !pins)
    fail(
      `The source archive of ${tag} has no desktop/src-tauri/src/install.rs: ${read.stderr.trim()}`,
    );
  const files: Planned[] = [
    {
      key: `${prefix}releases/${tag}/${tag}.tar.gz`,
      kind: "file",
      sha256: await fileSha256(archive),
      contentType: "application/gzip",
      cache: IMMUTABLE,
      path: archive,
    },
  ];
  const tool = (
    name: "podman" | "compose",
    constant: string,
    fn: string,
    base: string,
  ) => {
    const version = new RegExp(
      `const ${constant}: &str = "([0-9][0-9A-Za-z.+-]*)";`,
    ).exec(pins)?.[1];
    const body = new RegExp(`pub fn ${fn}\\(\\)[\\s\\S]*?\\n\\}`).exec(
      pins,
    )?.[0];
    const pairs = [
      ...(body ?? "").matchAll(/"([A-Za-z0-9._-]+)",\s*"([0-9a-f]{64})"/g),
    ];
    if (!version || pairs.length === 0)
      fail(`${tag}'s install.rs pins no ${name} downloads this can read.`);
    for (const [, file, sha256] of pairs) {
      files.push({
        key: `${prefix}tools/${name}/v${version}/${file}`,
        kind: "file",
        sha256: sha256 as string,
        contentType: "application/octet-stream",
        cache: IMMUTABLE,
        url: `${github}/${base}/releases/download/v${version}/${file}`,
      });
    }
  };
  tool("podman", "PODMAN", "podman_download", "podman-container-tools/podman");
  tool("compose", "COMPOSE", "compose_download", "docker/compose");
  return files;
}

const stableTag = /^v\d+\.\d+\.\d+$/;
const releaseTag = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The releases to copy: the one DOWNLOADS_TAG names, which may be a candidate or a beta; or else
 * the Latest stable release, and every published prerelease newer than it that is under 30 days
 * old, so a candidate's installs find their images here within a scheduled run of publishing.
 */
async function releasesToCopy(env: Env): Promise<string[]> {
  const repository =
    env.GITHUB_REPOSITORY ||
    fail("GITHUB_REPOSITORY must name the repository.");
  if (env.DOWNLOADS_TAG) return [env.DOWNLOADS_TAG];
  const latest = await run([
    "gh",
    "api",
    `repos/${repository}/releases/latest`,
    "--jq",
    ".tag_name",
  ]);
  if (latest.code !== 0) {
    fail(
      `Could not read the Latest release, so no image was copied: ${latest.stderr.trim()}`,
    );
  }
  const tag = new TextDecoder().decode(latest.stdout).trim();
  // A list given by hand is for one release.
  if (env.DOWNLOADS_IMAGES_FILE || !stableTag.test(tag)) return [tag];
  const listed = await run([
    "gh",
    "release",
    "list",
    "-R",
    repository,
    "--json",
    "tagName,isDraft,isPrerelease,createdAt",
    "--limit",
    "100",
  ]);
  if (listed.code !== 0) {
    fail(`Could not list the releases: ${listed.stderr.trim()}`);
  }
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const newer = (
    JSON.parse(new TextDecoder().decode(listed.stdout)) as {
      tagName: string;
      isDraft: boolean;
      isPrerelease: boolean;
      createdAt: string;
    }[]
  )
    .filter(
      (release) =>
        release.isPrerelease &&
        !release.isDraft &&
        releaseTag.test(release.tagName) &&
        Date.parse(release.createdAt) >= since &&
        Bun.semver.order(release.tagName.slice(1), tag.slice(1)) > 0,
    )
    .map((release) => release.tagName)
    .sort((a, b) => Bun.semver.order(a.slice(1), b.slice(1)));
  return [tag, ...newer];
}

/** The release, and the images to copy for it. */
async function readList(
  env: Env,
  work: string,
  tag: string,
): Promise<{ tag: string; label: string; images: string[] }> {
  const repository =
    env.GITHUB_REPOSITORY ||
    fail("GITHUB_REPOSITORY must name the repository.");
  const viewed = await run([
    "gh",
    "release",
    "view",
    tag,
    "-R",
    repository,
    "--json",
    "tagName,isDraft,isPrerelease,assets",
  ]);
  if (viewed.code !== 0)
    fail(`Could not read release ${tag}: ${viewed.stderr.trim()}`);
  const release = JSON.parse(new TextDecoder().decode(viewed.stdout)) as {
    isDraft: boolean;
    isPrerelease: boolean;
    assets: { name: string; digest?: string }[];
  };
  // A candidate or a beta is copied too, so its installs find their images here; a draft is not
  // published, and nothing installs it.
  if (release.isDraft || !releaseTag.test(tag)) {
    fail(`${tag} is a draft or not a release version. No image was copied.`);
  }
  if (!release.isPrerelease && !stableTag.test(tag)) {
    fail(
      `${tag} names a candidate but is not marked a prerelease. No image was copied.`,
    );
  }
  const dir = join(work, "release", tag);
  mkdirSync(dir, { recursive: true });
  /** A release asset's text, checked against the digest GitHub reports, or `undefined`. */
  const asset = async (name: string) => {
    const found = release.assets.find((candidate) => candidate.name === name);
    if (!found) return undefined;
    const expected = /^sha256:([0-9a-f]{64})$/.exec(found.digest ?? "")?.[1];
    if (!expected)
      fail(
        `GitHub reports no SHA-256 digest for ${name} on ${tag}, so it cannot be checked.`,
      );
    const downloaded = await run([
      "gh",
      "release",
      "download",
      tag,
      "-R",
      repository,
      "--pattern",
      name,
      "--dir",
      dir,
    ]);
    if (downloaded.code !== 0)
      fail(
        `Could not download ${name} from ${tag}: ${downloaded.stderr.trim()}`,
      );
    const bytes = await Bun.file(join(dir, name)).bytes();
    if (sha256Hex(bytes) !== expected) {
      fail(
        `${name} downloaded from ${tag} does not match the digest GitHub reports for it.`,
      );
    }
    return new TextDecoder().decode(bytes);
  };
  // Every image the release pins, whichever of them this app runs: a pinned reference is what
  // the app pulls, and a copy of one it does not is only space.
  const pins = await asset(PINS);
  const pinned =
    pins === undefined ? [] : pinnedImages(pins, `${PINS} on ${tag}`);
  if (pins === undefined) console.log(`::notice::${tag} has no ${PINS}.`);
  // And the back end's, the Kubernetes system images and the cluster's, which only the app's own
  // code can list (desktop-images.json).
  let listed: string[] = [];
  if (env.DOWNLOADS_IMAGES_FILE) {
    const from = env.DOWNLOADS_IMAGES_FILE;
    listed = parseList(await Bun.file(from).text(), from);
  } else {
    const text = await asset(LIST);
    if (text === undefined) {
      console.log(
        `::notice::${tag} has no ${LIST}: it was published before releases listed their images, so only the images ${PINS} names are copied.`,
      );
    } else {
      listed = parseList(text, `${LIST} on ${tag}`);
    }
  }
  return { tag, label: tag, images: [...new Set([...pinned, ...listed])] };
}

/**
 * Asks the address for every image's top manifest, as a client's first request for it does, and
 * fails naming each one that does not answer 200. A miss is asked again, twice, after
 * DOWNLOADS_VERIFY_DELAY seconds (default 10), which outlasts CloudFront's caching of a 403 from
 * before the upload.
 */
async function verify(
  refs: Ref[],
  options: {
    address: string;
    prefix: string;
    parallel: number;
    env: Env;
    label: string;
  },
): Promise<number> {
  const delay = Number(options.env.DOWNLOADS_VERIFY_DELAY ?? "10") * 1000;
  const base = (ref: Ref) =>
    `${options.address}/${options.prefix}v2/${ref.path}`;
  const tops = [
    ...new Map(
      refs.map((ref) => [
        `${base(ref)}/manifests/${ref.digest ?? ref.tag}`,
        ref,
      ]),
    ),
  ];
  /** Asks for each URL, three times at most, and gives what never answered `expected`. */
  const ask = async (
    urls: string[],
    read: (url: string, answer: Response) => Promise<void>,
  ) => {
    let missing = urls;
    let failed: string[] = [];
    for (let attempt = 1; attempt <= 3 && missing.length > 0; attempt++) {
      if (attempt > 1) await Bun.sleep(delay);
      failed = [];
      await pool(missing, options.parallel, async (url) => {
        try {
          // As a registry client asks: by the manifest types it reads.
          const answer = await fetch(url, {
            method: read === none ? "HEAD" : "GET",
            headers: { accept: MANIFEST_ACCEPT },
          });
          if (answer.status !== 200) failed.push(`${url} (${answer.status})`);
          else await read(url, answer);
        } catch (error) {
          failed.push(
            `${url} (${error instanceof Error ? error.message : error})`,
          );
        }
      });
      missing = failed.map((line) => line.slice(0, line.lastIndexOf(" (")));
    }
    return failed;
  };
  const none = async () => {};
  // Each image's top manifest, as a pull asks for it first, then every manifest an index names
  // and the referrers of each, as Docker 29 asks for them.
  const more: string[] = [];
  const failed = await ask(
    tops.map(([url]) => url),
    async (url, answer) => {
      const bytes = new Uint8Array(await answer.arrayBuffer());
      const ref = new Map(tops).get(url) as Ref;
      const document = JSON.parse(new TextDecoder().decode(bytes)) as {
        manifests?: { digest?: string }[];
      };
      const digests = [`sha256:${sha256Hex(bytes)}`];
      for (const child of document.manifests ?? []) {
        if (child.digest && digestPattern.test(child.digest)) {
          more.push(`${base(ref)}/manifests/${child.digest}`);
          digests.push(child.digest);
        }
      }
      for (const digest of digests)
        more.push(`${base(ref)}/referrers/${digest}`);
    },
  );
  failed.push(...(await ask([...new Set(more)], none)));
  if (failed.length > 0) {
    fail(
      `${failed.length} of the objects for the ${tops.length} images for ${options.label} do not answer through ${options.address}: ${failed.sort().join(", ")}`,
    );
  }
  console.log(
    `All ${tops.length} images for ${options.label} answer through ${options.address}, every manifest and referrers object included.`,
  );
  return 0;
}

function pinnedImages(text: string, from: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`${from} is not JSON.`);
  }
  const images = (
    parsed as { images?: Record<string, { reference?: unknown }> }
  ).images;
  const references = Object.values(images ?? {}).map(
    (image) => image?.reference,
  );
  if (
    references.length === 0 ||
    references.some((reference) => typeof reference !== "string")
  ) {
    fail(`${from} names no image references.`);
  }
  return references as string[];
}

function parseList(text: string, from: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`${from} is not JSON.`);
  }
  const images = (parsed as { images?: unknown }).images;
  if (
    !Array.isArray(images) ||
    images.some((image) => typeof image !== "string")
  ) {
    fail(`${from} has no list of images.`);
  }
  return images as string[];
}

type Copy = {
  label: string;
  images: string[];
  files: Planned[];
  bucket: string;
  distribution: string;
  prefix: string;
  address: string;
  parallel: number;
  source: string;
  work: string;
  env: Env;
};

async function copy(options: Copy): Promise<number> {
  const { bucket, prefix, parallel, source, work } = options;
  const copied: Ref[] = [];
  const elsewhere: string[] = [];
  for (const image of options.images) {
    const ref = imageRef(image, source);
    if (ref) copied.push(ref);
    else elsewhere.push(image);
  }
  for (const image of elsewhere)
    console.log(
      `${image} is not on ghcr.io, Docker Hub or quay.io; it is left to its own registry.`,
    );

  // What S3 holds for a key: its SHA-256 as S3 computed it on an upload sent with one, its
  // Content-Type and Cache-Control; `undefined` when the key is not there.
  const held = async (key: string) => {
    const head = await run([
      "aws",
      "s3api",
      "head-object",
      "--bucket",
      bucket,
      "--key",
      key,
      "--checksum-mode",
      "ENABLED",
      "--output",
      "json",
    ]);
    if (head.code !== 0) {
      if (head.stderr.includes("(404)")) return undefined;
      fail(`Could not read s3://${bucket}/${key}: ${head.stderr.trim()}`);
    }
    const found = JSON.parse(new TextDecoder().decode(head.stdout)) as {
      ChecksumSHA256?: string;
      CacheControl?: string;
      ContentType?: string;
    };
    return {
      sha256: found.ChecksumSHA256
        ? Buffer.from(found.ChecksumSHA256, "base64").toString("hex")
        : "",
      cache: found.CacheControl,
      contentType: found.ContentType,
    };
  };

  // What to write, by key. Manifests are read now, to learn what they name; blobs only if missing.
  const plan = new Map<string, Planned>();
  const add = (item: Planned) => {
    const known = plan.get(item.key);
    if (known && known.sha256 !== item.sha256) {
      fail(`${item.key} would be written twice with different bytes.`);
    }
    plan.set(item.key, item);
  };
  const manifest = async (ref: Ref, reference: string) => {
    const at = reference.startsWith("sha256:") ? "@" : ":";
    const read = await run([
      "crane",
      "manifest",
      `${ref.read}${at}${reference}`,
    ]);
    if (read.code !== 0) {
      fail(
        `Could not read ${ref.name}${at}${reference}: ${read.stderr.trim()}`,
      );
    }
    const bytes = read.stdout;
    let document: {
      mediaType?: string;
      manifests?: {
        mediaType?: string;
        digest?: string;
        platform?: { os?: string; architecture?: string };
      }[];
      config?: { digest?: string; size?: number };
      layers?: {
        digest?: string;
        size?: number;
        mediaType?: string;
        urls?: string[];
      }[];
    };
    try {
      document = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      fail(`${ref.name}${at}${reference} is not a JSON manifest.`);
    }
    return { bytes, document, digest: `sha256:${sha256Hex(bytes)}` };
  };
  const key = (
    ref: Ref,
    kind: "manifests" | "blobs" | "referrers",
    reference: string,
  ) => `${prefix}v2/${ref.path}/${kind}/${reference}`;
  const blobs = (
    ref: Ref,
    document: Awaited<ReturnType<typeof manifest>>["document"],
    name: string,
  ) => {
    const described = [document.config, ...(document.layers ?? [])];
    if (!document.config || !Array.isArray(document.layers))
      fail(`${name} names no config or no layers.`);
    for (const blob of described) {
      // A layer a client fetches from its own URLs is not in the registry to copy.
      if (
        blob &&
        "urls" in blob &&
        Array.isArray(blob.urls) &&
        blob.urls.length > 0
      )
        continue;
      if (
        !blob?.digest ||
        !digestPattern.test(blob.digest) ||
        !Number.isInteger(blob.size)
      ) {
        fail(`${name} names a blob without a digest and size.`);
      }
      add({
        key: key(ref, "blobs", blob.digest),
        kind: "blob",
        sha256: blob.digest.slice(7),
        contentType: "application/octet-stream",
        cache: IMMUTABLE,
        source: `${ref.read}@${blob.digest}`,
        size: blob.size,
      });
    }
  };

  // An empty referrers index for a manifest: a valid answer to the OCI referrers API (Docker 29
  // asks for one with every pull, and takes a 403 as a failed pull), and nothing refers to it here.
  const referrers = (ref: Ref, digest: string) =>
    add({
      key: key(ref, "referrers", digest),
      kind: "referrers",
      sha256: sha256Hex(EMPTY_REFERRERS),
      contentType: OCI_INDEX,
      cache: TAG_CACHE,
      bytes: EMPTY_REFERRERS,
    });

  let whole = 0;
  await pool(copied, parallel, async (ref) => {
    const reference = ref.digest ?? (ref.tag as string);
    const name = `${ref.name}${ref.digest ? "@" : ":"}${reference}`;
    // An image named by digest whose referrers S3 holds already is whole: they are uploaded only
    // after every manifest and blob the image is made of. Not read again, so Docker Hub's pull limit
    // is not spent. (Its manifest alone is not enough: a copy from before every child was copied
    // has the manifest and lacks the rest.)
    if (ref.digest) {
      const found = await held(key(ref, "referrers", ref.digest));
      if (found?.sha256 === sha256Hex(EMPTY_REFERRERS)) {
        whole++;
        return;
      }
    }
    const top = await manifest(ref, reference);
    if (ref.digest && top.digest !== ref.digest) {
      fail(`${name} served bytes whose digest is ${top.digest}.`);
    }
    const type = top.document.mediaType ?? "";
    referrers(ref, top.digest);
    if (INDEX_TYPES.has(type)) {
      // The whole index: every platform and every attestation it names. A client may fetch any of
      // them (Docker 29 fetches each child, attestations included), and one it cannot fetch fails
      // its pull.
      const children = top.document.manifests ?? [];
      if (children.length === 0) fail(`${name} names no manifests.`);
      for (const child of children) {
        if (!child.digest || !digestPattern.test(child.digest))
          fail(`${name} names a manifest without a digest.`);
        const childName = `${ref.name}@${child.digest}`;
        const found = await manifest(ref, child.digest);
        if (found.digest !== child.digest)
          fail(`${childName} served bytes whose digest is ${found.digest}.`);
        const childType = found.document.mediaType ?? "";
        if (
          !MANIFEST_TYPES.has(childType) ||
          (child.mediaType && child.mediaType !== childType)
        ) {
          fail(
            `${childName} is ${childType || "untyped"}, not the image manifest ${name} says it is.`,
          );
        }
        add({
          key: key(ref, "manifests", child.digest),
          kind: "manifest",
          sha256: found.digest.slice(7),
          contentType: childType,
          cache: IMMUTABLE,
          bytes: found.bytes,
        });
        blobs(ref, found.document, childName);
        referrers(ref, child.digest);
      }
      add({
        key: key(ref, "manifests", top.digest),
        kind: "index",
        sha256: top.digest.slice(7),
        contentType: type,
        cache: IMMUTABLE,
        bytes: top.bytes,
      });
    } else if (MANIFEST_TYPES.has(type)) {
      blobs(ref, top.document, name);
      add({
        key: key(ref, "manifests", top.digest),
        kind: "manifest",
        sha256: top.digest.slice(7),
        contentType: type,
        cache: IMMUTABLE,
        bytes: top.bytes,
      });
    } else {
      fail(
        `${name} is ${type || "untyped"}, which is not an image this can copy.`,
      );
    }
    if (ref.tag) {
      add({
        key: key(ref, "manifests", ref.tag),
        kind: "tag",
        sha256: top.digest.slice(7),
        contentType: type,
        cache: TAG_CACHE,
        bytes: top.bytes,
      });
    }
  });
  if (copied.length > 0) {
    const ping = new TextEncoder().encode("{}");
    add({
      key: `${prefix}v2/`,
      kind: "ping",
      sha256: sha256Hex(ping),
      contentType: "application/json",
      cache: TAG_CACHE,
      bytes: ping,
    });
  }

  // What S3 holds now. ChecksumSHA256 is what S3 computed on an upload sent with one; an object put
  // there any other way reads as different and is replaced.
  for (const file of options.files) add(file);
  const planned = [...plan.values()];
  const missing = new Set<string>();
  await pool(planned, parallel, async (item) => {
    const found = await held(item.key);
    if (
      found?.sha256 !== item.sha256 ||
      found.cache !== item.cache ||
      found.contentType !== item.contentType
    ) {
      missing.add(item.key);
    }
  });

  const order: Planned["kind"][] = [
    "file",
    "blob",
    "manifest",
    "index",
    "referrers",
    "tag",
    "ping",
  ];
  const uploads = planned
    .filter((item) => missing.has(item.key))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  console.log(
    `${copied.length} images for ${options.label} (${whole} already whole in s3://${bucket}): ${planned.length} objects, ${planned.length - uploads.length} already in s3://${bucket}, ${uploads.length} to upload.`,
  );
  if (uploads.length === 0) {
    console.log(
      `downloads.copilotkit.ai already serves every image and file for ${options.label}. Nothing to upload.`,
    );
    return await verify(copied, options);
  }

  mkdirSync(join(work, "objects"), { recursive: true });
  let n = 0;
  const put = async (item: Planned) => {
    const file = item.path ?? join(work, "objects", `${n++}`);
    if (item.path) {
      // Downloaded and hashed already.
    } else if (item.bytes) {
      await Bun.write(file, item.bytes);
    } else if (item.url) {
      const answer = await fetch(item.url);
      if (!answer.ok) fail(`Could not download ${item.url}: ${answer.status}`);
      await Bun.write(file, answer);
      if ((await fileSha256(file)) !== item.sha256) {
        fail(
          `${item.url} is not the file install.rs pins (sha256 ${item.sha256}). Nothing more was uploaded.`,
        );
      }
    } else {
      const read = await run(["crane", "blob", item.source as string], {
        stdout: file,
      });
      if (read.code !== 0)
        fail(`Could not read ${item.source}: ${read.stderr.trim()}`);
      if (
        statSync(file).size !== item.size ||
        (await fileSha256(file)) !== item.sha256
      ) {
        fail(
          `${item.source} served bytes that do not match its digest. Nothing more was uploaded.`,
        );
      }
    }
    const checksum = Buffer.from(item.sha256, "hex").toString("base64");
    // S3 refuses the upload unless the bytes it received hash to this checksum.
    const sent = await run([
      "aws",
      "s3api",
      "put-object",
      "--bucket",
      bucket,
      "--key",
      item.key,
      "--body",
      file,
      "--content-type",
      item.contentType,
      "--cache-control",
      item.cache,
      "--checksum-sha256",
      checksum,
      "--output",
      "json",
    ]);
    rmSync(file, { force: true });
    if (sent.code !== 0)
      fail(
        `Could not upload s3://${bucket}/${item.key}: ${sent.stderr.trim()}`,
      );
    console.log(`Uploaded s3://${bucket}/${item.key}.`);
  };
  // Each kind waits for the one before it, so a manifest is never served before what it names.
  for (const kind of order) {
    await pool(
      uploads.filter((item) => item.kind === kind),
      parallel,
      put,
    );
  }

  const mutable = uploads.filter(
    (item) => item.kind === "tag" || item.kind === "ping",
  );
  if (mutable.length > 0) {
    const invalidated = await run([
      "aws",
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      options.distribution,
      "--paths",
      ...mutable.map((item) => `/${item.key}`),
      "--output",
      "json",
    ]);
    if (invalidated.code !== 0)
      fail(
        `Could not invalidate the tags just uploaded: ${invalidated.stderr.trim()}`,
      );
    const id = JSON.parse(new TextDecoder().decode(invalidated.stdout))
      .Invalidation?.Id;
    console.log(`Invalidated ${mutable.length} paths (${id}).`);
  }

  // Fetched once through the address, so Origin Shield holds each one before anyone asks for it.
  // A fetch that fails is said, and does not undo the copy: anyone who asks gets it from S3.
  const cold: string[] = [];
  await pool(uploads, parallel, async (item) => {
    try {
      const answer = await fetch(`${options.address}/${item.key}`);
      await answer.arrayBuffer();
      if (!answer.ok) cold.push(`${item.key} (${answer.status})`);
    } catch (error) {
      cold.push(
        `${item.key} (${error instanceof Error ? error.message : error})`,
      );
    }
  });
  if (cold.length > 0) {
    console.log(
      `::warning::${cold.length} new objects did not come back through ${options.address}: ${cold.slice(0, 5).join(", ")}${cold.length > 5 ? `, and ${cold.length - 5} more` : ""}`,
    );
  } else {
    console.log(
      `Fetched ${uploads.length} new objects through ${options.address}.`,
    );
  }

  if (options.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `### downloads.copilotkit.ai now serves the images for ${options.label}`,
      "",
      `${copied.length} images from ghcr.io and Docker Hub, the source archive and the pinned tools; ${uploads.length} objects uploaded, ${planned.length - uploads.length} already there.`,
      ...(elsewhere.length > 0
        ? [
            "",
            `Left to their own registry: ${elsewhere.map((image) => `\`${image}\``).join(", ")}`,
          ]
        : []),
      "",
    ];
    const summary = Bun.file(options.env.GITHUB_STEP_SUMMARY);
    await Bun.write(
      summary,
      `${(await summary.exists()) ? await summary.text() : ""}${lines.join("\n")}\n`,
    );
  }
  return await verify(copied, options);
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.log(
      `::error::${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

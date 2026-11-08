/**
 * The Desktop app's images on downloads.copilotkit.ai. scripts/downloads-images.ts copies the images
 * a release's `desktop-images.json` names from ghcr.io into the bucket, under the registry's own
 * paths, and runs here as the workflow runs it, against a pretend `gh`, `aws` and `crane`
 * (scripts/downloads-fakes.ts) and a pretend CloudFront that answers from the pretend bucket as the
 * real one does: each object with its stored Content-Type, no Docker-Content-Digest, and 403 for a
 * key that is not there. Docker and containerd pull from it only if every manifest keeps its bytes
 * and its media type.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DISTRIBUTION,
  type FakeDownloads,
  fakeDownloads,
} from "./downloads-fakes";

const root = join(import.meta.dir, "..");
const script = join(root, "scripts/downloads-images.ts");
const TAG = "public, max-age=300";
const IMMUTABLE = "public, max-age=31536000, immutable";
const INDEX = "application/vnd.oci.image.index.v1+json";
const MANIFEST = "application/vnd.oci.image.manifest.v1+json";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const sha = (bytes: Uint8Array | string) =>
  `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;

/**
 * Pushes a two-platform image to the pretend ghcr.io as buildx does: an OCI index naming a
 * linux/amd64 and a linux/arm64 manifest and their attestation, each manifest a config and layers.
 * The index is indented, so rewriting it in any way changes its bytes and its digest.
 */
function push(fake: FakeDownloads, repo: string, tag: string) {
  const at = join(fake.env.FAKE_STATE as string, "registry", "ghcr.io", repo);
  const store = (
    kind: "manifests" | "blobs",
    name: string,
    bytes: Uint8Array | string,
  ) => {
    mkdirSync(join(at, kind), { recursive: true });
    writeFileSync(join(at, kind, name), bytes);
  };
  const blob = (bytes: Uint8Array | string) => {
    store("blobs", sha(bytes), bytes);
    return { digest: sha(bytes), size: Buffer.byteLength(bytes) };
  };
  const platforms: Record<string, string> = {};
  const entries = [];
  for (const architecture of ["amd64", "arm64", "unknown"]) {
    const config = blob(
      JSON.stringify({
        architecture,
        os: "linux",
        rootfs: { type: "layers", diff_ids: [] },
      }),
    );
    const layers = [
      crypto.getRandomValues(new Uint8Array(2048)),
      crypto.getRandomValues(new Uint8Array(512)),
    ].map((bytes) => ({
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      ...blob(bytes),
    }));
    const manifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: MANIFEST,
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        ...config,
      },
      layers,
    });
    store("manifests", sha(manifest), manifest);
    platforms[architecture] = sha(manifest);
    entries.push({
      mediaType: MANIFEST,
      digest: sha(manifest),
      size: manifest.length,
      platform:
        architecture === "unknown"
          ? { architecture, os: "unknown" }
          : { architecture, os: "linux" },
    });
  }
  const index = JSON.stringify(
    { schemaVersion: 2, mediaType: INDEX, manifests: entries },
    null,
    3,
  );
  store("manifests", sha(index), index);
  store("manifests", tag, index);
  return { index, digest: sha(index), platforms };
}

/**
 * What github.com serves for a release: its source archive, whose install.rs pins the engine's
 * installers, and those installers on the Podman and Compose release pages.
 */
function github(fake: FakeDownloads, tag: string) {
  const dir = join(fake.env.FAKE_STATE as string, "github");
  const files: Record<string, string> = {};
  const pin = (path: string, content: string) => {
    files[path] = content;
    return new Bun.CryptoHasher("sha256").update(content).digest("hex");
  };
  const podman = pin(
    "/podman-container-tools/podman/releases/download/v6.1.1/podman-installer-macos-arm64.pkg",
    "podman pkg",
  );
  const msi = pin(
    "/podman-container-tools/podman/releases/download/v6.1.1/podman-installer-windows-amd64.msi",
    "podman msi",
  );
  const compose = pin(
    "/docker/compose/releases/download/v5.5.1/docker-compose-darwin-aarch64",
    "compose arm64",
  );
  const source = join(
    dir,
    "src",
    `OpenBot-${tag.slice(1)}`,
    "desktop/src-tauri/src",
  );
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, "install.rs"),
    `pub const PODMAN: &str = "6.1.1";
pub const COMPOSE: &str = "5.5.1";

pub fn podman_download() -> Result<Download, Problem> {
    let (file, sha256) = match (std::env::consts::OS, crate::windows::machine_arch()) {
        ("windows", "x86_64") => (
            "podman-installer-windows-amd64.msi",
            "${msi}",
        ),
        ("macos", "aarch64") => (
            "podman-installer-macos-arm64.pkg",
            "${podman}",
        ),
    };
}

pub fn compose_download() -> Result<Download, Problem> {
    let (file, sha256) = match (std::env::consts::OS, crate::windows::machine_arch()) {
        ("macos", "aarch64") => (
            "docker-compose-darwin-aarch64",
            "${compose}",
        ),
    };
}
`,
  );
  const archive = join(dir, `${tag}.tar.gz`);
  expect(
    Bun.spawnSync([
      "tar",
      "-czf",
      archive,
      "-C",
      join(dir, "src"),
      `OpenBot-${tag.slice(1)}`,
    ]).exitCode,
  ).toBe(0);
  return {
    files,
    archive,
    path: `/CopilotKit/OpenBot/archive/refs/tags/${tag}.tar.gz`,
  };
}

/** CloudFront in front of the pretend bucket, as it answers: stored type, 403 for a missing key. */
function cloudfront(fake: FakeDownloads, hub: ReturnType<typeof github>) {
  const bucket = join(
    fake.env.FAKE_STATE as string,
    "s3",
    fake.env.DOWNLOADS_BUCKET as string,
  );
  const metas = join(
    fake.env.FAKE_STATE as string,
    "s3-meta",
    fake.env.DOWNLOADS_BUCKET as string,
  );
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/github/")) {
        const wanted = path.slice("/github".length);
        if (wanted === hub.path) return new Response(readFileSync(hub.archive));
        const file = hub.files[wanted];
        return file === undefined
          ? new Response("Not Found", { status: 404 })
          : new Response(file);
      }
      const key = decodeURIComponent(path.slice(1));
      const file = join(
        bucket,
        key.endsWith("/") ? `${key}.slash-object` : key,
      );
      if (!existsSync(file)) {
        requests.push(`403 ${key}`);
        return new Response("<Error><Code>AccessDenied</Code></Error>", {
          status: 403,
          headers: { "content-type": "application/xml" },
        });
      }
      const meta = JSON.parse(readFileSync(join(metas, `${key}.json`), "utf8"));
      requests.push(`200 ${key}`);
      return new Response(readFileSync(file), {
        headers: {
          "content-type": meta.ContentType,
          "cache-control": meta.CacheControl,
        },
      });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

async function run(fake: FakeDownloads, env: Record<string, string>) {
  const child = Bun.spawn(["bun", script], {
    cwd: root,
    env: { ...process.env, ...fake.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out: out + err };
}

test("a release's images are copied under the registry's paths, byte for byte and typed, once", async () => {
  const fake = fakeDownloads();
  cleanups.push(fake.cleanup);
  const server = push(fake, "copilotkit/openbot-server", "v0.3.4");
  const api = push(fake, "copilotkit/intelligence/app-api", "0.16.0-rc.9");
  const list = {
    openbot: "v0.3.4",
    intelligence: "0.16.0-rc.9",
    images: [
      "docker.io/rancher/mirrored-pause@sha256:74c4244427b7312c5b901fe0f67cbc53683d06f4f24c6faee65d4182bf0fa893",
      "ghcr.io/copilotkit/intelligence/app-api:0.16.0-rc.9",
      `ghcr.io/copilotkit/openbot-server@${server.digest}`,
      "pgvector/pgvector:pg17",
    ],
  };
  fake.release("v0.3.4", {
    "desktop-images.json": JSON.stringify(list),
    "latest.json": "{}",
  });
  fake.setLatest("v0.3.4");
  const hub = github(fake, "v0.3.4");
  const edge = cloudfront(fake, hub);
  const env = {
    DOWNLOADS_URL: edge.url,
    DOWNLOADS_GITHUB_URL: `${edge.url}/github`,
  };

  const first = await run(fake, env);
  expect(first.code).toBe(0);
  const bucket = fake.bucket();
  const manifests = (repo: string, image: ReturnType<typeof push>) => [
    `v2/${repo}/manifests/${image.digest}`,
    `v2/${repo}/manifests/${image.platforms.amd64}`,
    `v2/${repo}/manifests/${image.platforms.arm64}`,
  ];
  // Every index, each linux manifest, the tag the app reads, and the ping; no attestation.
  for (const key of [
    "v2/",
    ...manifests("copilotkit/openbot-server", server),
    ...manifests("copilotkit/intelligence/app-api", api),
    "v2/copilotkit/intelligence/app-api/manifests/0.16.0-rc.9",
  ]) {
    expect(Object.keys(bucket)).toContain(key);
  }
  expect(
    Object.keys(bucket).some((key) =>
      key.includes(server.platforms.unknown as string),
    ),
  ).toBe(false);
  expect(
    Object.keys(bucket).filter((key) => key.includes("/manifests/")),
  ).toHaveLength(7);
  // Two configs and four layers an image.
  expect(
    Object.keys(bucket).filter((key) => key.includes("/blobs/")),
  ).toHaveLength(12);
  expect(bucket["v2/"]).toEqual({
    content: "{}",
    contentType: "application/json",
    cacheControl: TAG,
    sha256: true,
  });
  expect(
    bucket[`v2/copilotkit/openbot-server/manifests/${server.digest}`],
  ).toEqual({
    content: server.index,
    contentType: INDEX,
    cacheControl: IMMUTABLE,
    sha256: true,
  });
  expect(
    bucket["v2/copilotkit/intelligence/app-api/manifests/0.16.0-rc.9"],
  ).toEqual({
    content: api.index,
    contentType: INDEX,
    cacheControl: TAG,
    sha256: true,
  });
  expect(
    bucket[`v2/copilotkit/openbot-server/manifests/${server.platforms.arm64}`],
  ).toMatchObject({
    contentType: MANIFEST,
    cacheControl: IMMUTABLE,
  });
  for (const [key, object] of Object.entries(bucket)) {
    if (key.includes("/blobs/")) {
      expect(object).toMatchObject({
        contentType: "application/octet-stream",
        cacheControl: IMMUTABLE,
      });
    }
  }
  // The source archive a deployment is laid out from, and the engine installers the release's
  // install.rs pins, checked against those pins, under fixed keys.
  expect(bucket["releases/v0.3.4/v0.3.4.tar.gz"]).toMatchObject({
    contentType: "application/gzip",
    cacheControl: IMMUTABLE,
    sha256: true,
  });
  expect(
    bucket["tools/podman/v6.1.1/podman-installer-macos-arm64.pkg"],
  ).toEqual({
    content: "podman pkg",
    contentType: "application/octet-stream",
    cacheControl: IMMUTABLE,
    sha256: true,
  });
  expect(
    bucket["tools/podman/v6.1.1/podman-installer-windows-amd64.msi"]?.content,
  ).toBe("podman msi");
  expect(
    bucket["tools/compose/v5.5.1/docker-compose-darwin-aarch64"]?.content,
  ).toBe("compose arm64");
  // Only ghcr.io is copied.
  expect(
    fake
      .calls()
      .some((call) => call.startsWith("crane") && /pause|pgvector/.test(call)),
  ).toBe(false);
  expect(first.out).toContain(
    "pgvector/pgvector:pg17 is not on ghcr.io; it is left to its own registry.",
  );
  // The tag and the ping are invalidated, after the last upload, and every new object fetched once
  // through the address.
  expect(fake.invalidations()).toEqual([
    `${DISTRIBUTION} /v2/copilotkit/intelligence/app-api/manifests/0.16.0-rc.9 /v2/`,
  ]);
  expect(edge.requests.sort()).toEqual(
    Object.keys(bucket)
      .map((key) => `200 ${key}`)
      .sort(),
  );
  // A pull asks for the ping, the tag, the index, its platform's manifest and its blobs: each is
  // served with its own type, and a key that is not there is 403, so a client moves to ghcr.io.
  const served = await fetch(
    `${edge.url}/v2/copilotkit/intelligence/app-api/manifests/0.16.0-rc.9`,
  );
  expect(served.headers.get("content-type")).toBe(INDEX);
  expect(served.headers.get("docker-content-digest")).toBeNull();
  expect(sha(await served.text())).toBe(api.digest);
  expect(
    (
      await fetch(
        `${edge.url}/v2/copilotkit/intelligence/app-api/manifests/latest`,
      )
    ).status,
  ).toBe(403);

  // Again: nothing is read from ghcr.io but the manifests, nothing uploaded, nothing invalidated.
  const before = fake.calls().length;
  const second = await run(fake, env);
  expect(second.code).toBe(0);
  expect(second.out).toContain(
    "already serves every image and file for v0.3.4. Nothing to upload.",
  );
  const again = fake.calls().slice(before);
  expect(again.some((call) => call.startsWith("aws s3api put-object"))).toBe(
    false,
  );
  expect(again.some((call) => call.startsWith("crane blob"))).toBe(false);
  expect(fake.invalidations()).toHaveLength(1);
}, 30_000);

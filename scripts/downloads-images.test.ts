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
function push(
  fake: FakeDownloads,
  repo: string,
  tag: string,
  registry = "ghcr.io",
) {
  const at = join(fake.env.FAKE_STATE as string, "registry", registry, repo);
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
  for (const architecture of ["amd64", "arm64", "s390x", "unknown"]) {
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
function cloudfront(
  fake: FakeDownloads,
  hub: ReturnType<typeof github>,
  ...more: ReturnType<typeof github>[]
) {
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
  /** Keys this edge answers 403 for whatever the bucket holds, as a stale cached error would. */
  const refused = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      // A registry client asks for a manifest by type; warming asks for the bytes, whatever they are.
      const asked =
        request.method === "HEAD" ||
        (request.headers.get("accept") ?? "").includes("vnd.oci");
      if (asked) requests.push(`${request.method} ${path.slice(1)}`);
      if (path.startsWith("/github/")) {
        const wanted = path.slice("/github".length);
        for (const release of [hub, ...more]) {
          if (wanted === release.path)
            return new Response(readFileSync(release.archive));
          const file = release.files[wanted];
          if (file !== undefined) return new Response(file);
        }
        return new Response("Not Found", { status: 404 });
      }
      const key = decodeURIComponent(path.slice(1));
      const file = join(
        bucket,
        key.endsWith("/") ? `${key}.slash-object` : key,
      );
      if (!existsSync(file) || refused.has(key)) {
        if (!asked) requests.push(`403 ${key}`);
        return new Response("<Error><Code>AccessDenied</Code></Error>", {
          status: 403,
          headers: { "content-type": "application/xml" },
        });
      }
      const meta = JSON.parse(readFileSync(join(metas, `${key}.json`), "utf8"));
      if (!asked) requests.push(`200 ${key}`);
      return new Response(readFileSync(file), {
        headers: {
          "content-type": meta.ContentType,
          "cache-control": meta.CacheControl,
        },
      });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, requests, refused };
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
  // Docker Hub's, named as Compose and the CLI name them: with no registry, and as docker.io/.
  const pgvector = push(fake, "pgvector/pgvector", "pg17", "docker.io");
  const busybox = push(fake, "library/busybox", "1.37", "docker.io");
  const k3s = push(fake, "rancher/k3s", "v1.32.5-k3s1", "docker.io");
  // quay.io's: the engine machine image the app downloads before Install, named by digest.
  const machineOs = push(fake, "podman/machine-os", "6.1", "quay.io");
  const list = {
    openbot: "v0.3.4",
    intelligence: "0.16.0-rc.9",
    images: [
      "busybox:1.37",
      `docker.io/rancher/k3s@${k3s.digest}`,
      "ghcr.io/copilotkit/intelligence/app-api:0.16.0-rc.9",
      `ghcr.io/copilotkit/openbot-server@${server.digest}`,
      "pgvector/pgvector:pg17",
      `quay.io/podman/machine-os@${machineOs.digest}`,
      "mcr.microsoft.com/someone/else:1",
    ],
  };
  // Every image the release pins is copied, listed in desktop-images.json or not.
  const supervisor = push(fake, "copilotkit/openbot-supervisor", "v0.3.4");
  const pins = {
    version: "v0.3.4",
    images: {
      server: {
        reference: `ghcr.io/copilotkit/openbot-server@${server.digest}`,
      },
      supervisor: {
        reference: `ghcr.io/copilotkit/openbot-supervisor@${supervisor.digest}`,
      },
    },
  };
  fake.release("v0.3.4", {
    "container-images.json": JSON.stringify(pins),
    "desktop-images.json": JSON.stringify(list),
    "latest.json": "{}",
  });
  fake.setLatest("v0.3.4");
  const hub = github(fake, "v0.3.4");
  const edge = cloudfront(fake, hub);
  const env = {
    DOWNLOADS_URL: edge.url,
    DOWNLOADS_GITHUB_URL: `${edge.url}/github`,
    DOWNLOADS_VERIFY_DELAY: "0",
  };

  const first = await run(fake, env);
  expect(first.code).toBe(0);
  // Each image's top manifest, every manifest its index names and the referrers of each are asked
  // for through the address before the run succeeds.
  expect(first.out).toContain(
    `All 7 images for v0.3.4 answer through ${edge.url}, every manifest and referrers object included.`,
  );
  expect(edge.requests).toContain(
    `GET v2/copilotkit/openbot-supervisor/manifests/${supervisor.digest}`,
  );
  for (const checked of [
    `HEAD v2/copilotkit/openbot-supervisor/manifests/${supervisor.platforms.unknown}`,
    `HEAD v2/copilotkit/openbot-supervisor/referrers/${supervisor.digest}`,
    `HEAD v2/copilotkit/openbot-supervisor/referrers/${supervisor.platforms.s390x}`,
  ]) {
    expect(edge.requests).toContain(checked);
  }
  expect(edge.requests).toContain(
    "GET v2/docker.io/library/busybox/manifests/1.37",
  );
  const bucket = fake.bucket();
  // The whole index: every platform, the attestation included, and the referrers of each.
  const manifests = (repo: string, image: ReturnType<typeof push>) => [
    `v2/${repo}/manifests/${image.digest}`,
    `v2/${repo}/referrers/${image.digest}`,
    ...Object.values(image.platforms).flatMap((digest) => [
      `v2/${repo}/manifests/${digest}`,
      `v2/${repo}/referrers/${digest}`,
    ]),
  ];
  // Every index, every manifest it names, the tag the app reads, and the ping.
  for (const key of [
    "v2/",
    ...manifests("copilotkit/openbot-server", server),
    ...manifests("copilotkit/intelligence/app-api", api),
    "v2/copilotkit/intelligence/app-api/manifests/0.16.0-rc.9",
    // Docker Hub's under docker.io/, an official image under library/.
    ...manifests("docker.io/pgvector/pgvector", pgvector),
    "v2/docker.io/pgvector/pgvector/manifests/pg17",
    ...manifests("docker.io/library/busybox", busybox),
    "v2/docker.io/library/busybox/manifests/1.37",
    ...manifests("docker.io/rancher/k3s", k3s),
    // quay.io's under quay.io/.
    ...manifests("quay.io/podman/machine-os", machineOs),
    // Named only by container-images.json.
    ...manifests("copilotkit/openbot-supervisor", supervisor),
  ]) {
    expect(Object.keys(bucket)).toContain(key);
  }
  expect(bucket["v2/docker.io/library/busybox/manifests/1.37"]).toEqual({
    content: busybox.index,
    contentType: INDEX,
    cacheControl: TAG,
    sha256: true,
  });
  // A referrers object is an empty image index, which says nothing refers to the manifest.
  expect(
    bucket[
      `v2/copilotkit/openbot-server/referrers/${server.platforms.unknown}`
    ],
  ).toEqual({
    content:
      '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}',
    contentType: INDEX,
    cacheControl: TAG,
    sha256: true,
  });
  // Seven images, each an index and four manifests (three platforms and an attestation), and three
  // tags; a referrers object for each manifest.
  expect(
    Object.keys(bucket).filter((key) => key.includes("/manifests/")),
  ).toHaveLength(38);
  expect(
    Object.keys(bucket).filter((key) => key.includes("/referrers/")),
  ).toHaveLength(35);
  // A config and two layers for each of the four manifests, an image.
  expect(
    Object.keys(bucket).filter((key) => key.includes("/blobs/")),
  ).toHaveLength(84);
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
  // Only ghcr.io, Docker Hub and quay.io are copied.
  expect(
    fake.calls().some((call) => call.startsWith("crane") && /mcr/.test(call)),
  ).toBe(false);
  expect(first.out).toContain(
    "mcr.microsoft.com/someone/else:1 is not on ghcr.io, Docker Hub or quay.io; it is left to its own registry.",
  );
  // The tags and the ping are invalidated together, after the last upload, and every new object
  // fetched once through the address.
  const [invalidation, ...more] = fake.invalidations();
  expect(more).toEqual([]);
  expect(invalidation?.split(" ").sort()).toEqual(
    [
      DISTRIBUTION,
      "/v2/",
      "/v2/copilotkit/intelligence/app-api/manifests/0.16.0-rc.9",
      "/v2/docker.io/library/busybox/manifests/1.37",
      "/v2/docker.io/pgvector/pgvector/manifests/pg17",
    ].sort(),
  );
  expect(
    edge.requests
      .filter((line) => !line.startsWith("HEAD ") && !line.startsWith("GET "))
      .sort(),
  ).toEqual(
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

  // Again: only the tags are read from the registries, since an image named by digest whose
  // manifest S3 holds is whole; nothing uploaded, nothing invalidated.
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
  expect(
    again.filter((call) => call.startsWith("crane manifest")).sort(),
  ).toEqual(
    [
      "crane manifest docker.io/library/busybox:1.37",
      "crane manifest docker.io/pgvector/pgvector:pg17",
      "crane manifest ghcr.io/copilotkit/intelligence/app-api:0.16.0-rc.9",
      ...[
        "docker.io/library/busybox",
        "docker.io/pgvector/pgvector",
        "ghcr.io/copilotkit/intelligence/app-api",
      ].flatMap((repo) => {
        const image = {
          "docker.io/library/busybox": busybox,
          "docker.io/pgvector/pgvector": pgvector,
          "ghcr.io/copilotkit/intelligence/app-api": api,
        }[repo] as ReturnType<typeof push>;
        return Object.values(image.platforms).map(
          (digest) => `crane manifest ${repo}@${digest}`,
        );
      }),
    ].sort(),
  );
  expect(fake.invalidations()).toHaveLength(1);

  // An image that does not answer through the address fails the run, named, so the job stops
  // before downloads-sync.sh moves latest/ to this release.
  const stale = `v2/copilotkit/openbot-supervisor/manifests/${supervisor.digest}`;
  edge.refused.add(stale);
  const refused = await run(fake, env);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain(
    `::error::1 of the objects for the 7 images for v0.3.4 do not answer through ${edge.url}: ${edge.url}/${stale} (403)`,
  );
  // The check alone, as a person runs it after a release: no AWS, no registry.
  const checked = (bucketless: Record<string, string>) =>
    run(fake, {
      ...env,
      DOWNLOADS_VERIFY_ONLY: "1",
      DOWNLOADS_BUCKET: "",
      DOWNLOADS_DISTRIBUTION_ID: "",
      ...bucketless,
    });
  const awsBefore = fake
    .calls()
    .filter((call) => /^(aws|crane) /.test(call)).length;
  expect((await checked({})).code).toBe(1);
  edge.refused.clear();
  const whole = await checked({});
  expect(whole.code).toBe(0);
  expect(whole.out).toContain(
    `All 7 images for v0.3.4 answer through ${edge.url}, every manifest and referrers object included.`,
  );
  expect(fake.calls().filter((call) => /^(aws|crane) /.test(call)).length).toBe(
    awsBefore,
  );
}, 30_000);

// A release candidate's installs pull its images too, so they are copied as soon as it is published:
// asked for by tag, or found by the scheduled run beside the Latest release. A draft is not.
test("a prerelease's images are copied, by tag or beside Latest; old ones and drafts are not", async () => {
  const fake = fakeDownloads();
  cleanups.push(fake.cleanup);
  const pin = (tag: string, image: ReturnType<typeof push>, repo: string) =>
    JSON.stringify({
      version: tag,
      images: { server: { reference: `ghcr.io/${repo}@${image.digest}` } },
    });
  const stable = push(fake, "copilotkit/openbot-server", "v0.3.4");
  const candidate = push(fake, "copilotkit/openbot-server", "v1.0.0-rc.1");
  push(fake, "copilotkit/intelligence/app-api", "0.17.0");
  const stale = push(fake, "copilotkit/openbot-stale", "v0.9.0-rc.1");
  const older = push(fake, "copilotkit/openbot-older", "v0.3.4-rc.1");
  const drafted = push(fake, "copilotkit/openbot-draft", "v1.0.0-rc.2");
  const day = 24 * 60 * 60 * 1000;
  fake.release("v0.3.4", {
    "container-images.json": pin("v0.3.4", stable, "copilotkit/openbot-server"),
  });
  fake.release(
    "v1.0.0-rc.1",
    {
      "container-images.json": pin(
        "v1.0.0-rc.1",
        candidate,
        "copilotkit/openbot-server",
      ),
      "desktop-images.json": JSON.stringify({
        images: ["ghcr.io/copilotkit/intelligence/app-api:0.17.0"],
      }),
    },
    { prerelease: true },
  );
  fake.release(
    "v0.9.0-rc.1",
    {
      "container-images.json": pin(
        "v0.9.0-rc.1",
        stale,
        "copilotkit/openbot-stale",
      ),
    },
    {
      prerelease: true,
      createdAt: new Date(Date.now() - 40 * day).toISOString(),
    },
  );
  fake.release(
    "v0.3.4-rc.1",
    {
      "container-images.json": pin(
        "v0.3.4-rc.1",
        older,
        "copilotkit/openbot-older",
      ),
    },
    { prerelease: true },
  );
  fake.release(
    "v1.0.0-rc.2",
    {
      "container-images.json": pin(
        "v1.0.0-rc.2",
        drafted,
        "copilotkit/openbot-draft",
      ),
    },
    { prerelease: true, draft: true },
  );
  fake.setLatest("v0.3.4");
  const edge = cloudfront(
    fake,
    github(fake, "v0.3.4"),
    github(fake, "v1.0.0-rc.1"),
  );
  const env = {
    DOWNLOADS_URL: edge.url,
    DOWNLOADS_GITHUB_URL: `${edge.url}/github`,
    DOWNLOADS_VERIFY_DELAY: "0",
  };

  // The scheduled run: Latest, and the candidate newer than it from this month.
  const scheduled = await run(fake, env);
  expect(scheduled.code).toBe(0);
  const keys = Object.keys(fake.bucket());
  for (const key of [
    `v2/copilotkit/openbot-server/manifests/${stable.digest}`,
    `v2/copilotkit/openbot-server/manifests/${candidate.digest}`,
    `v2/copilotkit/openbot-server/manifests/${candidate.platforms.arm64}`,
    "v2/copilotkit/intelligence/app-api/manifests/0.17.0",
    "releases/v1.0.0-rc.1/v1.0.0-rc.1.tar.gz",
  ]) {
    expect(keys).toContain(key);
  }
  expect(scheduled.out).toContain(
    `All 2 images for v1.0.0-rc.1 answer through ${edge.url}, every manifest and referrers object included.`,
  );
  // Not one older than Latest, one over 30 days old, or a draft; and never latest/.
  for (const repo of ["openbot-stale", "openbot-older", "openbot-draft"]) {
    expect(keys.some((key) => key.includes(repo))).toBe(false);
  }
  expect(keys.some((key) => key.startsWith("latest/"))).toBe(false);

  // Asked for by tag, the candidate is copied (it is whole already), and the draft is refused.
  const asked = await run(fake, { ...env, DOWNLOADS_TAG: "v1.0.0-rc.1" });
  expect(asked.code).toBe(0);
  expect(asked.out).toContain(
    "already serves every image and file for v1.0.0-rc.1",
  );
  const draft = await run(fake, { ...env, DOWNLOADS_TAG: "v1.0.0-rc.2" });
  expect(draft.code).toBe(1);
  expect(draft.out).toContain(
    "::error::v1.0.0-rc.2 is a draft or not a release version. No image was copied.",
  );
  expect(
    Object.keys(fake.bucket()).some((key) => key.includes("openbot-draft")),
  ).toBe(false);
}, 30_000);

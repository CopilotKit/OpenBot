import { expect, test } from "bun:test";
import {
  type Blob,
  blobsOf,
  checks,
  type DiskNeeds,
  downloadBytes,
  type Fetch,
  figures,
  type ImageList,
  installations,
  partOf,
  readNeeds,
  repository,
  type Sizes,
} from "./disk-needs";

const GIB = 1024 ** 3;
const MB = 1_000_000;

const needs: DiskNeeds = {
  installFreeGb: 20,
  installedGb: { from: 7, to: 10 },
  backEndFreeGb: 15,
  imagesDownloadMb: 1200,
  mostAnUpdateDownloadsMb: 2000,
  onDisk: 4,
};

const SERVER = "ghcr.io/copilotkit/openbot@sha256:aaa";
const DATABASE = "pgvector/pgvector:pg17";
const SMALL_BOT = "ghcr.io/copilotkit/openbot-agent-ag2@sha256:bbb";
const LARGE_BOT = "ghcr.io/copilotkit/openbot-agent-crewai@sha256:ccc";
const CLAUDE = "ghcr.io/copilotkit/openbot-agent-claude-sdk@sha256:ddd";
const NODE = "docker.io/rancher/k3s@sha256:eee";
const BACK_END = "ghcr.io/copilotkit/intelligence/app-api:0.16.0";
const MACHINE = "quay.io/podman/machine-os@sha256:fff";

/** Blobs of `mb` megabytes each, named so two images can share one. */
const blobs = (...named: [string, number][]): Blob[] =>
  named.map(([digest, mb]) => ({ digest, size: mb * MB }));

test("each image is put with the part of an installation that pulls it", () => {
  expect(repository(SERVER)).toBe("copilotkit/openbot");
  expect(repository(DATABASE)).toBe("pgvector/pgvector");
  expect(repository(BACK_END)).toBe("copilotkit/intelligence/app-api");
  expect(
    [SERVER, DATABASE, SMALL_BOT, CLAUDE, NODE, BACK_END, MACHINE].map(partOf),
  ).toEqual([
    "openbot",
    "openbot",
    "framework",
    "sign-in",
    "back-end",
    "back-end",
    "machine",
  ]);
  // The server's own image up to v1.0.3, and the k3d load balancer the CLI does not run.
  expect(partOf("ghcr.io/copilotkit/openbot-server@sha256:111")).toBe(
    "openbot",
  );
  expect(partOf("ghcr.io/k3d-io/k3d-proxy@sha256:222")).toBe("other");
});

test("a blob two images share is downloaded once", () => {
  const sizes: Sizes = new Map([
    [SMALL_BOT, blobs(["python", 30], ["ag2", 10])],
    [CLAUDE, blobs(["python", 30], ["claude", 50])],
  ]);
  expect(downloadBytes([SMALL_BOT, CLAUDE], sizes)).toBe(90 * MB);
});

const list: ImageList = {
  images: [
    SERVER,
    DATABASE,
    SMALL_BOT,
    LARGE_BOT,
    CLAUDE,
    NODE,
    BACK_END,
    MACHINE,
  ],
};
const sizes: Sizes = new Map([
  [SERVER, blobs(["server", 800])],
  [DATABASE, blobs(["postgres", 160])],
  [SMALL_BOT, blobs(["python", 30], ["ag2", 30])],
  [LARGE_BOT, blobs(["python", 30], ["crewai", 350])],
  [CLAUDE, blobs(["python", 30], ["claude", 130])],
  [NODE, blobs(["k3s", 70])],
  [BACK_END, blobs(["api", 600])],
  [MACHINE, blobs(["machine", 900])],
]);

test("an installation is the smallest framework alone, up to the largest with the sign-in images", () => {
  const install = installations(list, sizes);
  expect(install.smallest).toEqual([
    SERVER,
    DATABASE,
    NODE,
    BACK_END,
    SMALL_BOT,
  ]);
  expect(install.largest).toEqual([
    SERVER,
    DATABASE,
    NODE,
    BACK_END,
    LARGE_BOT,
    CLAUDE,
  ]);
  // Podman's machine image is on the computer's drive, not in what OpenBot installs.
  expect(install.everything).not.toContain(MACHINE);
});

test("an update counts only what the release before it did not have, held beside it", () => {
  const before: ImageList = {
    images: [SERVER.replace("aaa", "old"), DATABASE, CLAUDE, NODE, BACK_END],
  };
  const older = new Map(sizes);
  older.set(SERVER.replace("aaa", "old"), blobs(["server-old", 780]));
  const f = figures(
    "v2",
    list,
    [{ release: "v1", list: before }],
    older,
    needs,
  );
  // The new server image is the only new blob: 800 MB downloaded, 4 times that on disk.
  expect(f.largestUpdate).toBe(800 * MB * 4);
  expect(f.largestUpdateFrom).toBe("v1 to v2");
  expect(f.installedSmallest).toBe((800 + 160 + 70 + 600 + 30 + 30) * MB * 4);
  expect(f.installedLargest).toBe(
    (800 + 160 + 70 + 600 + 30 + 350 + 130) * MB * 4,
  );
  expect(f.everythingDownload).toBe((800 + 160 + 130 + 30 + 70 + 600) * MB);
});

test("each number the window says holds, or says what it should be", () => {
  const f = figures("v2", list, [], sizes, needs);
  expect(checks(f, needs).filter((check) => !check.holds)).toEqual([]);
  // Three times the downloads: OpenBot no longer fits in what the window says.
  const tripled = new Map(
    [...sizes].map(([ref, b]) => [
      ref,
      b.map((blob) => ({ ...blob, size: blob.size * 3 })),
    ]),
  );
  const stale = checks(figures("v3", list, [], tripled, needs), needs).filter(
    (check) => !check.holds,
  );
  expect(stale.map((check) => check.name)).toEqual([
    "installedGb.to",
    "installFreeGb",
    "imagesDownloadMb",
    "mostAnUpdateDownloadsMb",
  ]);
  expect(stale[0].fix).toBe(
    `"to": ${Math.ceil(((800 + 160 + 70 + 600 + 30 + 350 + 130) * 3 * MB * 4) / GIB)}`,
  );
});

test("an image's download is read from its registry, the larger of arm64 and amd64", async () => {
  const asked: string[] = [];
  const get: Fetch = async (url) => {
    asked.push(url);
    if (url.includes("/token") || url.includes("/v2/auth"))
      return { token: "anonymous" };
    if (url.endsWith("/manifests/0.16.0")) {
      return {
        manifests: [
          {
            digest: "sha256:arm",
            platform: { os: "linux", architecture: "arm64" },
          },
          {
            digest: "sha256:amd",
            platform: { os: "linux", architecture: "amd64" },
          },
          {
            digest: "sha256:att",
            platform: { os: "unknown", architecture: "unknown" },
          },
        ],
      };
    }
    if (url.endsWith("/manifests/sha256:arm"))
      return {
        config: { digest: "c1", size: 1 },
        layers: [{ digest: "l1", size: 100 }],
      };
    if (url.endsWith("/manifests/sha256:amd"))
      return {
        config: { digest: "c2", size: 1 },
        layers: [{ digest: "l2", size: 120 }],
      };
    throw new Error(`unexpected ${url}`);
  };
  expect(await blobsOf(BACK_END, get)).toEqual([
    { digest: "c2", size: 1 },
    { digest: "l2", size: 120 },
  ]);
  expect(asked[0]).toBe(
    "https://ghcr.io/token?scope=repository:copilotkit/intelligence/app-api:pull",
  );
  // A Docker Hub short name asks Docker Hub's own token service.
  asked.length = 0;
  await blobsOf(DATABASE, async (url) => {
    asked.push(url);
    return url.includes("auth.docker.io")
      ? { token: "anonymous" }
      : { config: { digest: "c", size: 1 }, layers: [] };
  });
  expect(asked).toEqual([
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:pgvector/pgvector:pull",
    "https://registry-1.docker.io/v2/pgvector/pgvector/manifests/pg17",
  ]);
});

test("the numbers the window says fit together", () => {
  const said = readNeeds();
  // The back end's setup is part of an installation, and an update is held to the same room.
  expect(said.backEndFreeGb).toBeLessThan(said.installFreeGb);
  expect(said.installedGb.from).toBeLessThan(said.installedGb.to);
  expect(said.installedGb.to).toBeLessThan(said.installFreeGb);
  expect(said.onDisk).toBeGreaterThan(1);
});

import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * The 1.0.2 and 1.0.3 apps, put back over an installation a newer app updated, must start it as it
 * is, for one release. Both stopped with "container-images.json for <release> names no agent-bot
 * image", and on a Mac with Podman they would then have met Compose's refusal of their port
 * overlay. So this release's manifest still names `agent-bot` and `agent-langgraph`, as the image
 * the server runs from, and its Compose file still defines both services, started by nothing.
 *
 * That image is the OpenBot image, which runs the server and every Bot's computer, each started
 * with its own command. Those apps ask for a `server` image and an `agent-computer` image, so the
 * manifest names the one image under both, and under the two names kept for them: one image behind
 * all five names they read but the supervisor's. They start `server`, `agent-computer`, `worker`
 * and `migrate` by name, with no command of their own, so this release's Compose file gives each
 * the executable and the command for its part.
 *
 * What those apps require is read from fixtures taken byte for byte from their tags, and checked
 * against the manifest and the Compose file this repository writes.
 */
const root = join(import.meta.dir, "..");
const fixtures = join(root, "desktop/src-tauri/test-fixtures/older-apps");
const TAGS = ["v1.0.2", "v1.0.3"] as const;
const KEPT = ["agent-bot", "agent-langgraph"];
/** The names an app reads the server's image and the computer's under: both the OpenBot image. */
const ONE_IMAGE = ["server", "agent-computer"];

const work = mkdtempSync(join(tmpdir(), "openbot-older-apps-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const has = (tool: string, ...args: string[]) =>
  spawnSync(tool, args, { stdio: "ignore" }).status === 0;
const jq = has("jq", "--version");
const compose = has("docker", "compose", "version");

type Manifest = {
  version: string;
  commit: string;
  images: Record<
    string,
    { repository: string; digest: string; reference: string }
  >;
};

/**
 * `IMAGE_VARIABLES` as the tag has it: desktop/src-tauri/src/deployment.rs, lines 70 to 80, at
 * v1.0.2 and at v1.0.3. A published name, then the Compose variable the app sets from it.
 */
function imageVariables(tag: string): Array<[string, string]> {
  const source = readFileSync(
    join(fixtures, `image-variables-${tag}.rs.txt`),
    "utf8",
  );
  return [...source.matchAll(/^ {4}\("([^"]+)", "([A-Z_]+)"\),$/gm)].map(
    (found) => [found[1] as string, found[2] as string],
  );
}

/**
 * `pin` as the tag has it (desktop/src-tauri/src/deployment.rs at v1.0.2 and v1.0.3, the same
 * text in both): every name in `IMAGE_VARIABLES` must be in the manifest, or the app stops before
 * any Compose command with this sentence. What it returns is what the app hands Compose.
 */
function olderAppPin(tag: string, manifest: Manifest): Record<string, string> {
  const pinned: Record<string, string> = {};
  for (const [published, variable] of imageVariables(tag)) {
    const image = manifest.images[published];
    if (!image)
      throw new Error(
        `container-images.json for ${manifest.version} names no ${published} image.`,
      );
    pinned[variable] = image.reference;
  }
  return pinned;
}

const digest = (name: string) =>
  `sha256:${new Bun.CryptoHasher("sha256").update(name).digest("hex")}`;

/** The two images a release pins and the ones it builds, as the jobs before `manifest` record them. */
function componentManifests(directory: string) {
  const built = JSON.parse(
    readFileSync(join(root, ".github/published-images.json"), "utf8"),
  ) as string[];
  const pinned = ["openbot", "supervisor"];
  mkdirSync(join(directory, "manifests"), { recursive: true });
  for (const name of [...pinned, ...built]) {
    const image = name === "openbot" ? "openbot" : `openbot-${name}`;
    writeFileSync(
      join(directory, "manifests", `${name}.json`),
      JSON.stringify({
        name,
        repository: `ghcr.io/copilotkit/${image}`,
        digest: digest(name),
      }),
    );
  }
  return { built, pinned };
}

/** The manifest a release writes: the `manifest` job's own step in images.yml, run as it is. */
function releaseManifest(): Manifest {
  const directory = join(work, "release");
  const { built } = componentManifests(directory);
  const workflow = parse(
    readFileSync(join(root, ".github/workflows/images.yml"), "utf8"),
  ) as {
    jobs: { manifest: { steps: Array<{ name?: string; run?: string }> } };
  };
  const step = workflow.jobs.manifest.steps.find(
    (candidate) => candidate.name === "Write the image manifest",
  );
  if (!step?.run) throw new Error("images.yml has no manifest step to run");
  execFileSync("bash", ["-c", step.run], {
    cwd: directory,
    env: {
      PATH: process.env.PATH ?? "",
      VERSION: "v9.9.9",
      COMMIT: "0".repeat(40),
      COMPONENTS: JSON.stringify(built),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return JSON.parse(
    readFileSync(join(directory, "container-images.json"), "utf8"),
  ) as Manifest;
}

test("the fixtures are what 1.0.2 and 1.0.3 require: five images, both Bots among them", () => {
  for (const tag of TAGS) {
    expect(imageVariables(tag)).toEqual([
      ["server", "SERVER_IMAGE"],
      ["supervisor", "SUPERVISOR_IMAGE"],
      ["agent-computer", "COMPUTER_IMAGE"],
      ["agent-bot", "BOT_IMAGE"],
      ["agent-langgraph", "LANGGRAPH_IMAGE"],
    ]);
    // desktop/src-tauri/src/macos-podman-ports.yml at the tag, which the app writes whole.
    const overlay = readFileSync(
      join(fixtures, `macos-podman-ports-${tag}.yml`),
      "utf8",
    );
    expect(
      [...overlay.matchAll(/^ {2}([a-z-]+):$/gm)].map((found) => found[1]),
    ).toEqual([
      "postgres",
      "supervisor",
      "agent-computer",
      "agent-bot",
      "agent-langgraph",
      "agent-harness",
      "server",
    ]);
  }
});

test.skipIf(!jq)(
  "the manifest a release writes is one the 1.0.2 and 1.0.3 apps accept",
  () => {
    const manifest = releaseManifest();
    const openbot = manifest.images.openbot;
    expect(openbot?.reference).toBe(
      `ghcr.io/copilotkit/openbot@${digest("openbot")}`,
    );
    for (const tag of TAGS) {
      const pinned = olderAppPin(tag, manifest);
      // The one image behind every name those apps read, but the supervisor's.
      expect(pinned.SERVER_IMAGE).toBe(openbot.reference);
      expect(pinned.COMPUTER_IMAGE).toBe(openbot.reference);
      expect(pinned.BOT_IMAGE).toBe(openbot.reference);
      expect(pinned.LANGGRAPH_IMAGE).toBe(openbot.reference);
      expect(pinned.SUPERVISOR_IMAGE).toBe(
        `ghcr.io/copilotkit/openbot-supervisor@${digest("supervisor")}`,
      );
    }
    // The OpenBot image under four more names: the same repository, digest and reference.
    for (const name of [...ONE_IMAGE, ...KEPT])
      expect(manifest.images[name]).toEqual(openbot);
    // And no image more than the ones that were built or pinned, so nothing more to copy or pull.
    const { built, pinned } = componentManifests(join(work, "counted"));
    expect(Object.keys(manifest.images).sort()).toEqual(
      [...built, ...pinned, ...ONE_IMAGE, ...KEPT].sort(),
    );
    expect(
      new Set(Object.values(manifest.images).map((image) => image.reference))
        .size,
    ).toBe(built.length + pinned.length);

    // What both apps said of a manifest without them.
    const without = structuredClone(manifest);
    for (const name of KEPT) delete without.images[name];
    for (const tag of TAGS) {
      expect(() => olderAppPin(tag, without)).toThrow(
        "container-images.json for v9.9.9 names no agent-bot image.",
      );
    }
  },
);

test.skipIf(!jq)(
  "a local build's manifest names the server image for both, whatever its base release named",
  () => {
    const script = readFileSync(
      join(root, "desktop/scripts/local-build.sh"),
      "utf8",
    );
    // The program the script hands jq to write its manifest, from the script itself.
    const program =
      /--argjson pinned "\$PINNED" \\\n {2}'([^']+)' "\$base"/.exec(
        script,
      )?.[1];
    if (!program) throw new Error("local-build.sh writes no manifest");
    const image = (name: string) => ({
      repository: `ghcr.io/copilotkit/openbot-${name}`,
      digest: digest(name),
      reference: `ghcr.io/copilotkit/openbot-${name}@${digest(name)}`,
    });
    const base = join(work, "base.json");
    // 1.0.3's manifest named an image of its own for each.
    writeFileSync(
      base,
      JSON.stringify({
        version: "v1.0.3",
        images: {
          "agent-bot": image("agent-bot"),
          "agent-langgraph": image("agent-langgraph"),
        },
      }),
    );
    const manifest = JSON.parse(
      execFileSync(
        "jq",
        [
          "--arg",
          "version",
          "internal-abc",
          "--arg",
          "commit",
          "0".repeat(40),
          "--argjson",
          "built",
          JSON.stringify({ "agent-claude-sdk": image("agent-claude-sdk") }),
          "--argjson",
          "pinned",
          JSON.stringify({ server: image("server") }),
          program,
          base,
        ],
        { encoding: "utf8" },
      ),
    ) as Manifest;
    for (const name of KEPT)
      expect(manifest.images[name]).toEqual(image("server"));
  },
);

const OPENBOT_IMAGE = `ghcr.io/copilotkit/openbot@${digest("openbot")}`;

/**
 * `docker compose config` over this release's file and the overlay an older app writes beside it
 * on a Mac with Podman, with that app's profile. It reads files only: no engine, no containers.
 */
function config(tag: string, composeFile: string, ...args: string[]) {
  const directory = mkdtempSync(join(work, `compose-${tag}-`));
  writeFileSync(join(directory, "docker-compose.yml"), composeFile);
  copyFileSync(
    join(fixtures, `macos-podman-ports-${tag}.yml`),
    join(directory, ".openbot-macos-podman.yml"),
  );
  // As a release's manifest has them: one image for the server and the computer, and the
  // supervisor's own.
  const manifest = {
    version: "v9.9.9",
    commit: "0".repeat(40),
    images: Object.fromEntries(
      [
        ["server", OPENBOT_IMAGE],
        ["agent-computer", OPENBOT_IMAGE],
        [
          "supervisor",
          `ghcr.io/copilotkit/openbot-supervisor@${digest("supervisor")}`,
        ],
      ].map(([name, reference]) => [
        name,
        { repository: "", digest: "", reference },
      ]),
    ),
  };
  for (const name of KEPT) manifest.images[name] = manifest.images.server;
  return spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      "/dev/null",
      "-f",
      "docker-compose.yml",
      "-f",
      ".openbot-macos-podman.yml",
      "--profile",
      "openbot",
      "config",
      ...args,
    ],
    {
      cwd: directory,
      // What the app hands Compose: the variables it pinned, and nothing of this machine's.
      env: { PATH: process.env.PATH ?? "", ...olderAppPin(tag, manifest) },
      encoding: "utf8",
    },
  );
}

const composeFile = () =>
  readFileSync(join(root, "docker-compose.yml"), "utf8");

if (!compose)
  console.warn(
    "tests/older-apps.test.ts: Docker Compose is not on PATH, so the Compose checks are skipped.",
  );

test.skipIf(!compose)(
  "Compose accepts each older app's port overlay over this release's file",
  () => {
    for (const tag of TAGS) {
      const quiet = config(tag, composeFile(), "--quiet");
      expect({ tag, code: quiet.status, said: quiet.stderr }).toEqual({
        tag,
        code: 0,
        said: "",
      });
      // What those apps start, and the migration they run once. Naming them is how they start
      // them, and neither service kept for them is among what that brings up.
      const started = config(
        tag,
        composeFile(),
        "--format",
        "json",
        "postgres",
        "agent-computer",
        "server",
        "worker",
        "migrate",
      );
      expect({ tag, said: started.stderr }).toEqual({ tag, said: "" });
      const services = (
        JSON.parse(started.stdout) as {
          services: Record<
            string,
            {
              image: string;
              ports?: unknown[];
              entrypoint?: string[] | null;
              command?: string[] | null;
              working_dir?: string;
            }
          >;
        }
      ).services;
      expect(Object.keys(services).sort()).toEqual([
        "agent-computer",
        "migrate",
        "postgres",
        "server",
        "worker",
      ]);
      // One image for all four, and each started as its own part of it. The app names the
      // service and no command, so the executable and the command are this file's to give: with
      // neither, the image would start the whole of OpenBot in each of the four containers.
      const startedAs = Object.fromEntries(
        ["server", "agent-computer", "worker", "migrate"].map((name) => [
          name,
          {
            image: services[name]?.image,
            runs: [
              ...(services[name]?.entrypoint ?? []),
              ...(services[name]?.command ?? []),
            ],
          },
        ]),
      );
      expect(startedAs).toEqual({
        server: { image: OPENBOT_IMAGE, runs: ["/app/bin/openbot", "server"] },
        "agent-computer": {
          image: OPENBOT_IMAGE,
          runs: ["/app/bin/openbot-computer"],
        },
        worker: { image: OPENBOT_IMAGE, runs: ["/app/bin/openbot", "worker"] },
        migrate: {
          image: OPENBOT_IMAGE,
          runs: ["/app/bin/openbot", "migrate"],
        },
      });
      for (const name of ["server", "worker", "migrate"])
        expect(services[name]?.working_dir).toBe("/app/server");
      // The overlay did its work: IPv4 loopback alone, as Podman on a Mac needs.
      expect(JSON.stringify(services.server?.ports)).not.toContain("::1");
    }
  },
  30_000,
);

test.skipIf(!compose)(
  "without the two services kept for them, Compose refuses the overlay as it did on a Mac with Podman",
  () => {
    const without = composeFile().replace(
      /^(?: {2}#.*\n)* {2}(?:agent-bot|agent-langgraph):\n(?: {4}.*\n)+/gm,
      "",
    );
    expect(Object.keys(parse(without).services)).not.toContain("agent-bot");
    for (const tag of TAGS) {
      const refused = config(tag, without, "--quiet");
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain(
        "has neither an image nor a build context specified",
      );
    }
  },
  30_000,
);

test("both services are kept behind a profile nothing turns on, on the image the server runs from", () => {
  const services = (
    parse(composeFile()) as {
      services: Record<
        string,
        { profiles?: string[]; image?: string; ports?: unknown }
      >;
    }
  ).services;
  for (const name of KEPT) {
    expect(services[name]).toEqual({
      profiles: ["for-older-apps"],
      image: services.server?.image,
      pull_policy: "never",
      restart: "no",
    });
  }
  // Nothing else is behind that profile, and nothing in the repository asks for it.
  const behind = Object.entries(services)
    .filter(([, service]) => service.profiles?.includes("for-older-apps"))
    .map(([name]) => name);
  expect(behind).toEqual(KEPT);
  for (const file of [
    "scripts/start.sh",
    "desktop/src-tauri/src/stack.rs",
    "desktop/src-tauri/src/main.rs",
    "desktop/src-tauri/src/preparation.rs",
  ]) {
    const source = readFileSync(join(root, file), "utf8");
    expect({
      file,
      asks: /--profile[", ]+for-older-apps|COMPOSE_PROFILES.*for-older-apps/.test(
        source,
      ),
    }).toEqual({ file, asks: false });
  }
});

test.skipIf(!compose)(
  "this app's own commands bring up neither service, with every profile it ever turns on",
  () => {
    const listed = spawnSync(
      "docker",
      [
        "compose",
        "--env-file",
        "/dev/null",
        "--profile",
        "openbot",
        "--profile",
        "harness",
        "config",
        "--services",
      ],
      { cwd: root, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" },
    );
    expect(listed.stderr).toBe("");
    const services = listed.stdout.trim().split("\n");
    expect(services).toContain("server");
    expect(services).toContain("agent-harness");
    for (const name of KEPT) expect(services).not.toContain(name);
  },
  30_000,
);

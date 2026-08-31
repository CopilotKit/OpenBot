/**
 * The catalogue: the directory shipped in the box, and a repository an administrator pinned.
 *
 * NOTHING HERE REACHES THE NETWORK. Every source test drives an injected fetch, because the
 * properties worth asserting are what this deployment does with what a source sends back — the
 * caps, the refusals, and the skip that is deliberately not fatal — and a test that ran against
 * `raw.githubusercontent.com` would be asserting whatever that host served that morning, on a
 * machine that may have no egress at all.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActor } from "../src/agents/profile-types";
import { loadConfig } from "../src/config";
import {
  type CatalogueRefusedError,
  createTemplateCatalogue,
  loadTemplateDirectory,
  parseSourceHandle,
  SOURCE_LIMITS,
  SOURCE_MANIFEST,
  type TemplateFetch,
} from "../src/templates/catalogue";

/*
 * A skip is announced on `console.warn`, which is the point of it — an operator reading logs finds
 * the filename and the reason. Silenced here so a suite that deliberately feeds in broken files does
 * not read as a suite that is failing.
 */
const quiet = spyOn(console, "warn").mockImplementation(() => {});
afterEach(() => {
  quiet.mockClear();
});

const admin: AgentActor = { id: "admin@openbot.test", role: "admin" };
const user: AgentActor = { id: "someone@openbot.test", role: "user" };

/**
 * The two characters a template may never carry, spelled apart from the name they would expand.
 *
 * Written this way so that this test file does not itself contain the sequence in a form an editor,
 * a linter or a reader would take for an intended interpolation — which is the whole reason the
 * parser refuses it in somebody else's file.
 */
const INTERPOLATION_OPEN = "${";

const ALLOWED = "jerelvelarde/awesome-openbot-templates";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function templateYaml(slug: string): string {
  return `openbot_template: 1
template:
  slug: ${slug}
  summary: A coworker that does one thing.
bot:
  name: ${slug}
  title: Desk
  role_description: Do the one thing, and say which document you used.
  avatar_seed: ${slug}
  runtime: managed
  skills: []
skills: []
`;
}

async function directoryHolding(
  files: Record<string, string>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openbot-templates-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(directory, name), body, "utf8");
  }
  return directory;
}

/** A source that serves exactly what it is given, and 404s everything else. */
function servingFetch(files: Record<string, string>): TemplateFetch {
  return async (url) => {
    const path = url.replace(
      `https://raw.githubusercontent.com/jerelvelarde/awesome-openbot-templates/${SHA}/`,
      "",
    );
    const body = files[path];
    if (body === undefined) return new Response("Not Found", { status: 404 });
    return new Response(body, { status: 200 });
  };
}

function catalogueWith(options: {
  directory?: string;
  allowed?: string[];
  floor?: "anyone" | "admin";
  fetch?: TemplateFetch;
}) {
  return createTemplateCatalogue({
    directory: options.directory ?? join(tmpdir(), "openbot-templates-absent"),
    allowedSources: new Set(options.allowed ?? [ALLOWED]),
    installerFloor: options.floor ?? "anyone",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

async function registered(fetcher: TemplateFetch) {
  const catalogue = catalogueWith({ fetch: fetcher });
  await catalogue.registerSource(admin, { handle: ALLOWED, sha: SHA });
  return catalogue;
}

function refusal(error: unknown): string {
  return (error as CatalogueRefusedError).reason;
}

describe("the in-box directory", () => {
  test("a malformed file is skipped and named while the others still load", async () => {
    const directory = await directoryHolding({
      "a-desk.yaml": templateYaml("a-desk"),
      "broken.yaml": "openbot_template: 1\nbot: [not, a, map]\n",
      "z-desk.yaml": templateYaml("z-desk"),
    });

    const listing = await loadTemplateDirectory(directory);

    expect(listing.entries.map((entry) => entry.slug)).toEqual([
      "a-desk",
      "z-desk",
    ]);
    expect(listing.skipped).toHaveLength(1);
    expect(listing.skipped[0]?.where).toBe("broken.yaml");
    expect(listing.skipped[0]?.message.length).toBeGreaterThan(0);
  });

  test("a document carrying an environment reference is skipped, not expanded", async () => {
    const directory = await directoryHolding({
      "leak.yaml": templateYaml("leak").replace(
        "Do the one thing",
        `Do the one thing with ${INTERPOLATION_OPEN}KEY_ENCRYPTION_KEY}`,
      ),
      "fine.yaml": templateYaml("fine"),
    });

    const listing = await loadTemplateDirectory(directory);

    expect(listing.entries.map((entry) => entry.slug)).toEqual(["fine"]);
    expect(listing.skipped[0]?.reason).toBe("interpolation");
  });

  test("two files claiming one slug: the first keeps the name", async () => {
    const directory = await directoryHolding({
      "a.yaml": templateYaml("renewal-desk"),
      "b.yaml": templateYaml("renewal-desk"),
    });

    const listing = await loadTemplateDirectory(directory);

    expect(listing.entries).toHaveLength(1);
    expect(listing.entries[0]?.origin).toEqual({
      kind: "directory",
      filename: "a.yaml",
    });
    expect(listing.skipped[0]).toMatchObject({
      where: "b.yaml",
      reason: "duplicate_slug",
    });
  });

  test("a directory that is not there is an empty gallery, not a refusal to start", async () => {
    const listing = await loadTemplateDirectory(
      join(tmpdir(), "openbot-templates-that-do-not-exist"),
    );

    expect(listing.entries).toEqual([]);
    expect(listing.skipped[0]?.reason).toBe("unreadable");
  });

  test("the shipped templates parse", async () => {
    // Resolved from this file rather than from the working directory, because `bun test` runs at the
    // repository root while the server resolves `OPENBOT_TEMPLATE_DIR` from `server/`.
    const listing = await loadTemplateDirectory(
      join(import.meta.dir, "../../examples/templates"),
    );

    expect(listing.skipped).toEqual([]);
    expect(listing.entries.length).toBeGreaterThan(0);
    for (const entry of listing.entries) {
      expect(entry.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("one template is read back by its own slug", async () => {
    const directory = await directoryHolding({
      "named-differently.yaml": templateYaml("a-desk"),
    });
    const catalogue = catalogueWith({ directory });

    expect(await catalogue.fromDirectory("a-desk")).toMatchObject({
      slug: "a-desk",
    });
    expect(await catalogue.fromDirectory("named-differently")).toBeNull();
  });
});

describe("registering a source", () => {
  test("a repository not on the allowlist is refused", async () => {
    const catalogue = catalogueWith({ allowed: [ALLOWED] });

    await expect(
      catalogue.registerSource(admin, {
        handle: "attacker/templates",
        sha: SHA,
      }),
    ).rejects.toThrow(/OPENBOT_TEMPLATE_SOURCES/);

    try {
      await catalogue.registerSource(admin, {
        handle: "attacker/templates",
        sha: SHA,
      });
    } catch (error) {
      expect(refusal(error)).toBe("not_allowlisted");
    }
    expect(catalogue.sources()).toEqual([]);
  });

  test("the allowlist is not evaded by capitalising the handle", async () => {
    const catalogue = catalogueWith({ allowed: [ALLOWED] });

    // The same repository, spelled the way GitHub also accepts it.
    const source = await catalogue.registerSource(admin, {
      handle: "JerelVelarde/Awesome-OpenBot-Templates",
      sha: SHA,
    });
    expect(source.id).toBe(ALLOWED);

    await expect(
      catalogue.registerSource(admin, {
        handle: "Attacker/Templates",
        sha: SHA,
      }),
    ).rejects.toThrow();
  });

  test("a ref that is not a 40-character sha is refused", async () => {
    const catalogue = catalogueWith({});

    for (const sha of [
      "main",
      "v1.2.0",
      SHA.slice(0, 7),
      `${SHA}0`,
      "z".repeat(40),
    ]) {
      try {
        await catalogue.registerSource(admin, { handle: ALLOWED, sha });
        throw new Error(`"${sha}" was accepted as a pin`);
      } catch (error) {
        expect(refusal(error)).toBe("bad_ref");
      }
    }
    expect(catalogue.sources()).toEqual([]);
  });

  test("a handle that is not owner/repo is refused before the allowlist is consulted", async () => {
    const catalogue = catalogueWith({});

    for (const handle of [
      "https://github.com/jerelvelarde/awesome-openbot-templates",
      "jerelvelarde/awesome-openbot-templates/tree/main",
      "jerelvelarde",
      "jerelvelarde/..",
    ]) {
      try {
        await catalogue.registerSource(admin, { handle, sha: SHA });
        throw new Error(`"${handle}" was accepted as a handle`);
      } catch (error) {
        expect(refusal(error)).toBe("bad_handle");
      }
    }
  });

  test("moving the pin replaces the registration rather than adding a second", async () => {
    const catalogue = catalogueWith({});
    await catalogue.registerSource(admin, { handle: ALLOWED, sha: SHA });
    const moved = await catalogue.registerSource(admin, {
      handle: ALLOWED,
      sha: "f".repeat(40),
    });

    expect(catalogue.sources()).toHaveLength(1);
    expect(moved.sha).toBe("f".repeat(40));
  });

  test("only an administrator may register or forget a source", async () => {
    const catalogue = catalogueWith({});

    try {
      await catalogue.registerSource(user, { handle: ALLOWED, sha: SHA });
      throw new Error("a plain user registered a source");
    } catch (error) {
      expect(refusal(error)).toBe("not_admin");
    }

    await catalogue.registerSource(admin, { handle: ALLOWED, sha: SHA });
    await expect(catalogue.forgetSource(user, ALLOWED)).rejects.toThrow();
    expect(await catalogue.forgetSource(admin, ALLOWED)).toBe(true);
    expect(catalogue.sources()).toEqual([]);
  });

  test("nothing is fetched from a source nobody registered", async () => {
    let calls = 0;
    const catalogue = catalogueWith({
      fetch: async () => {
        calls += 1;
        return new Response("", { status: 200 });
      },
    });

    await expect(catalogue.fromSource(ALLOWED)).rejects.toThrow(
      /is registered on this deployment/,
    );
    expect(calls).toBe(0);
  });
});

describe("reading a registered source", () => {
  test("the manifest names the files, and each one is fetched at the pin", async () => {
    const urls: string[] = [];
    const serve = servingFetch({
      [SOURCE_MANIFEST]: JSON.stringify({
        templates: ["renewal-desk.openbot.yaml", "nested/ticket-triage.yaml"],
      }),
      "renewal-desk.openbot.yaml": templateYaml("renewal-desk"),
      "nested/ticket-triage.yaml": templateYaml("ticket-triage"),
    });
    const catalogue = await registered(async (url) => {
      urls.push(url);
      return serve(url);
    });

    const listing = await catalogue.fromSource(ALLOWED);

    expect(listing.entries.map((entry) => entry.slug)).toEqual([
      "renewal-desk",
      "ticket-triage",
    ]);
    expect(listing.skipped).toEqual([]);
    for (const url of urls) {
      expect(
        url.startsWith(
          `https://raw.githubusercontent.com/jerelvelarde/awesome-openbot-templates/${SHA}/`,
        ),
      ).toBe(true);
    }
    expect(
      await catalogue.fromSourceBySlug(ALLOWED, "ticket-triage"),
    ).toMatchObject({
      origin: {
        kind: "source",
        sourceId: ALLOWED,
        sha: SHA,
        path: "nested/ticket-triage.yaml",
      },
    });
  });

  test("a file that does not parse is skipped and named, never fatal", async () => {
    const catalogue = await registered(
      servingFetch({
        [SOURCE_MANIFEST]: JSON.stringify({
          templates: ["good.yaml", "broken.yaml", "missing.yaml"],
        }),
        "good.yaml": templateYaml("good"),
        "broken.yaml": "openbot_template: 9\n",
      }),
    );

    const listing = await catalogue.fromSource(ALLOWED);

    expect(listing.entries.map((entry) => entry.slug)).toEqual(["good"]);
    expect(listing.skipped.map((skip) => [skip.where, skip.reason])).toEqual([
      ["broken.yaml", "format_version"],
      ["missing.yaml", "unreachable"],
    ]);
  });

  test("a path that escapes the repository is refused, and the URL is never built", async () => {
    const asked: string[] = [];
    const serve = servingFetch({
      [SOURCE_MANIFEST]: JSON.stringify({
        templates: ["../../etc/passwd.yaml", "/etc/shadow.yaml", "fine.yaml"],
      }),
      "fine.yaml": templateYaml("fine"),
    });
    const catalogue = await registered(async (url) => {
      asked.push(url);
      return serve(url);
    });

    const listing = await catalogue.fromSource(ALLOWED);

    expect(listing.entries.map((entry) => entry.slug)).toEqual(["fine"]);
    expect(listing.skipped.map((skip) => skip.reason)).toEqual([
      "bad_path",
      "bad_path",
    ]);
    expect(asked.some((url) => url.includes(".."))).toBe(false);
    expect(asked.some((url) => url.includes("shadow"))).toBe(false);
  });

  test("a source publishing no manifest holds nothing", async () => {
    const catalogue = await registered(servingFetch({}));

    const listing = await catalogue.fromSource(ALLOWED);

    expect(listing.entries).toEqual([]);
    expect(listing.skipped[0]?.reason).toBe("no_manifest");
  });

  test("a manifest that is not a manifest refuses the listing", async () => {
    const catalogue = await registered(
      servingFetch({ [SOURCE_MANIFEST]: "<!doctype html><html>hello" }),
    );

    try {
      await catalogue.fromSource(ALLOWED);
      throw new Error("an HTML page was accepted as a manifest");
    } catch (error) {
      expect(refusal(error)).toBe("bad_manifest");
    }
  });

  test("the file cap refuses rather than reading the first two hundred", async () => {
    const templates = Array.from(
      { length: SOURCE_LIMITS.FILES + 1 },
      (_, index) => `desk-${index}.yaml`,
    );
    let fetched = 0;
    const catalogue = await registered(async () => {
      fetched += 1;
      return new Response(JSON.stringify({ templates }), { status: 200 });
    });

    try {
      await catalogue.fromSource(ALLOWED);
      throw new Error("an oversized manifest was accepted");
    } catch (error) {
      expect(refusal(error)).toBe("too_many_files");
    }
    // The manifest, and not one file beyond it.
    expect(fetched).toBe(1);
  });

  test("the byte cap refuses a source that would exhaust the deployment", async () => {
    const enormous = "#".repeat(SOURCE_LIMITS.TOTAL_BYTES + 1);
    const catalogue = await registered(
      servingFetch({
        [SOURCE_MANIFEST]: JSON.stringify({ templates: ["huge.yaml"] }),
        "huge.yaml": enormous,
      }),
    );

    try {
      await catalogue.fromSource(ALLOWED);
      throw new Error("an oversized file was read");
    } catch (error) {
      expect(refusal(error)).toBe("too_large");
    }
  });

  test("a declared length over the cap refuses, whatever the body turns out to be", async () => {
    /*
     * The header is a claim and the body here contradicts it. Refusing on the claim is the point: a
     * response that says it is four megabytes is refused before four megabytes are in this process,
     * and the measured length is checked afterwards for the responses that carry no header at all.
     */
    const catalogue = await registered(async (url) => {
      if (url.endsWith(SOURCE_MANIFEST)) {
        return new Response(JSON.stringify({ templates: ["huge.yaml"] }), {
          status: 200,
        });
      }
      return new Response("small", {
        status: 200,
        headers: { "content-length": String(SOURCE_LIMITS.TOTAL_BYTES + 1) },
      });
    });

    try {
      await catalogue.fromSource(ALLOWED);
      throw new Error("a body claiming to be enormous was accepted");
    } catch (error) {
      expect(refusal(error)).toBe("too_large");
    }
  });

  test("a pin is fetched once, because a commit sha names one immutable tree", async () => {
    let calls = 0;
    const serve = servingFetch({
      [SOURCE_MANIFEST]: JSON.stringify({ templates: ["a.yaml"] }),
      "a.yaml": templateYaml("a-desk"),
    });
    const catalogue = await registered((url) => {
      calls += 1;
      return serve(url);
    });

    await catalogue.fromSource(ALLOWED);
    await catalogue.fromSource(ALLOWED);

    expect(calls).toBe(2);
  });
});

describe("who may install", () => {
  test("the environment's floor cannot be loosened by an administrator", () => {
    const catalogue = catalogueWith({ floor: "admin" });

    expect(catalogue.installers()).toBe("admin");
    try {
      catalogue.setInstallers(admin, "anyone");
      throw new Error("the floor was lowered");
    } catch (error) {
      expect(refusal(error)).toBe("installers_floor");
    }
    expect(catalogue.installers()).toBe("admin");
  });

  test("a deployment that set no floor can be tightened, and tightened back", () => {
    const catalogue = catalogueWith({ floor: "anyone" });

    expect(catalogue.setInstallers(admin, "admin")).toBe("admin");
    expect(catalogue.installers()).toBe("admin");
    expect(catalogue.setInstallers(admin, "anyone")).toBe("anyone");
  });

  test("a plain user cannot change it", () => {
    const catalogue = catalogueWith({ floor: "anyone" });

    try {
      catalogue.setInstallers(user, "admin");
      throw new Error("a plain user changed the setting");
    } catch (error) {
      expect(refusal(error)).toBe("not_admin");
    }
  });
});

describe("handles", () => {
  test("what is and is not an owner/repo", () => {
    expect(parseSourceHandle("Acme/Templates")).toEqual({
      owner: "acme",
      repo: "templates",
    });
    expect(parseSourceHandle(" acme/openbot.templates ")).toEqual({
      owner: "acme",
      repo: "openbot.templates",
    });
    expect(parseSourceHandle("acme")).toBeNull();
    expect(parseSourceHandle("acme/te mplates")).toBeNull();
    expect(parseSourceHandle("acme/a/b")).toBeNull();
    expect(parseSourceHandle("-acme/templates")).toBeNull();
    expect(parseSourceHandle("acme/..")).toBeNull();
  });
});

describe("the catalogue's configuration", () => {
  const base = {
    DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    INTELLIGENCE_API_URL: "http://localhost:7100",
    INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
    INTELLIGENCE_API_KEY: "tenant-api-key",
    COPILOTKIT_LICENSE_TOKEN: "license-token",
    OPENBOT_SINGLE_USER: "true",
  };

  test("the directory defaults beside the tenant package's", () => {
    expect(loadConfig(base).templateDirectory).toBe("../examples/templates");
    expect(
      loadConfig({ ...base, OPENBOT_TEMPLATE_DIR: "/srv/templates" })
        .templateDirectory,
    ).toBe("/srv/templates");
  });

  test("the source allowlist ships empty", () => {
    expect([...loadConfig(base).templateSources]).toEqual([]);
  });

  test("the allowlist is lowercased and refuses anything that is not owner/repo", () => {
    expect([
      ...loadConfig({
        ...base,
        OPENBOT_TEMPLATE_SOURCES:
          " JerelVelarde/Awesome-OpenBot-Templates , acme/desks ",
      }).templateSources,
    ]).toEqual([ALLOWED, "acme/desks"]);

    expect(() =>
      loadConfig({
        ...base,
        OPENBOT_TEMPLATE_SOURCES:
          "https://github.com/jerelvelarde/awesome-openbot-templates",
      }),
    ).toThrow(/OPENBOT_TEMPLATE_SOURCES/);
  });

  test("installers default to anyone and refuse a value that is neither", () => {
    expect(loadConfig(base).templateInstallers).toBe("anyone");
    expect(
      loadConfig({ ...base, OPENBOT_TEMPLATE_INSTALLERS: "admin" })
        .templateInstallers,
    ).toBe("admin");
    expect(() =>
      loadConfig({ ...base, OPENBOT_TEMPLATE_INSTALLERS: "administrator" }),
    ).toThrow(/OPENBOT_TEMPLATE_INSTALLERS/);
  });
});

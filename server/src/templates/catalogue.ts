/**
 * The two places a deployment finds templates nobody here wrote: the directory shipped in the image,
 * and a git repository an administrator pinned.
 *
 * NOTHING IS FETCHED FROM THE NETWORK UNLESS AN ADMINISTRATOR HAS REGISTERED A SOURCE, and that is
 * the property this file exists to keep rather than a preference. A self-hosted product that reaches
 * a third party on first boot because the vendor shipped a default has made that decision for its
 * operator. `OPENBOT_TEMPLATE_SOURCES` ships empty, the registry starts empty, and a deployment with
 * no network at all still opens the gallery and finds the in-box directory in it.
 *
 * PER-FILE ISOLATION, WHICH IS THE ONE DELIBERATE DIVERGENCE FROM THE PACKAGE LOADER. A malformed
 * `agents.yaml` kills the process before it serves, because `loadTenantPackage` runs in an unguarded
 * top-level await in `index.ts`, and that is right: a tenant package is an operator's own
 * configuration and a deployment running half of it is worse than one that did not come up. A
 * directory of many authors' files is the opposite case. One person's typo must not stop somebody
 * else's deployment booting, so every file is parsed on its own and a failure is logged with the
 * filename and the reason and skipped. This is the same judgement `synchronizeTenantPackage` already
 * makes for a colliding skill slug: name what was passed over, keep going.
 *
 * A SKIP IS DATA, not only a log line. Every listing carries the files it could not read alongside
 * the ones it could, so an administrator looking at the gallery can be shown "three templates, one
 * skipped" rather than being left to infer an absence. A file that silently vanishes from a
 * catalogue reads as a file that was never there.
 *
 * WHAT THIS FILE DOES NOT DO. It never installs anything, never writes a grant and never touches the
 * database. It hands a parsed document and its digest to the resolver and the installer, which is
 * the same document a paste would have produced — a gallery entry is a stranger's file that happened
 * to arrive by a different road, and it goes through every refusal that road already has.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type BotTemplate,
  botTemplateDigest,
  parseBotTemplate,
  TEMPLATE_LIMITS,
  TemplateRefusedError,
} from "../../../shared/bot-template";
import type { AgentActor } from "../agents/profile-types";

/**
 * Who may install a template on this deployment.
 *
 * `anyone` is the default because the whole write set of an install is what `POST /api/agents`,
 * `POST /api/plugins/skills` and `POST /api/plugins/grants` already permit the same person: there is
 * no fourth call, so requiring an administrator would be a ceremony around acts that person can
 * already perform one at a time. A deployment that wants the ceremony anyway says so.
 */
export type TemplateInstallers = "anyone" | "admin";

const INSTALLERS: readonly TemplateInstallers[] = ["anyone", "admin"];

/**
 * Read the setting out of a string, or say it is not one.
 *
 * A predicate rather than a coercion. `OPENBOT_TEMPLATE_INSTALLERS=administrator` is a deployment
 * that meant to restrict installs and would otherwise get `anyone` while believing it had said the
 * opposite, which is the failure the whole boot boundary in `config.ts` exists to prevent.
 */
export function isTemplateInstallers(
  value: string,
): value is TemplateInstallers {
  return (INSTALLERS as readonly string[]).includes(value);
}

/** An `owner/repo` on GitHub, lowercased, because a handle there is case-insensitive. */
export type TemplateSourceHandle = { owner: string; repo: string };

/**
 * GitHub's own shapes for the two halves of a handle.
 *
 * Narrow on purpose, and narrower than "not a slash". These two values are interpolated into a URL
 * with no escaping, so anything admitted here that could carry a `/`, a `?`, a `#` or a `..` would
 * be a way to point a server-side fetch at a path nobody registered. The charset is the answer to
 * that rather than an escape pass, because an escape pass is a thing to get wrong once.
 */
const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const REPO = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** A commit, spelled the one way a commit is spelled. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * `owner/repo` as a handle, or null.
 *
 * One function, called by the environment allowlist and by registration alike, so the allowlist
 * cannot admit a spelling registration would refuse or the other way round. `resolve.ts` carries a
 * note about being a second copy of the slug rule; this is that lesson applied before the fact.
 */
export function parseSourceHandle(value: string): TemplateSourceHandle | null {
  const parts = value.trim().toLowerCase().split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  if (!OWNER.test(owner) || !REPO.test(repo)) return null;
  // `.` and `..` pass the charset and are path traversal in a URL, so they are named here.
  if (repo === "." || repo === "..") return null;
  return { owner, repo };
}

/** The key an allowlist and a registry agree on. */
export function sourceHandleKey(handle: TemplateSourceHandle): string {
  return `${handle.owner}/${handle.repo}`;
}

/**
 * What a source may spend of this deployment's attention.
 *
 * A registered source is a third party that decides how many files it publishes and how big they
 * are, so every one of these is a number this deployment chose rather than one the source did.
 * `FILES` and `TOTAL_BYTES` are the two that matter: without them a repository whose owner has a bad
 * day, or whose account is taken, holds the gallery request open until it runs the process out of
 * memory. `MANIFEST_BYTES` is separate and much smaller because the manifest is a list of names.
 */
export const SOURCE_LIMITS = {
  FILES: 200,
  TOTAL_BYTES: 4 * 1024 * 1024,
  MANIFEST_BYTES: 64 * 1024,
  PATH_LENGTH: 200,
} as const;

/**
 * The file a source publishes saying what it holds.
 *
 * `raw.githubusercontent.com` serves one file at a time and cannot list a directory, so a catalogue
 * has to say what is in it. The alternative is `api.github.com`'s tree endpoint, which is a second
 * host, an unauthenticated rate limit shared with everybody behind the same address, and a listing
 * whose size the source decides. A manifest at a fixed path is one fetch of a bounded document, and
 * a source that does not publish one holds nothing rather than falling back to something looser.
 */
export const SOURCE_MANIFEST = "openbot-templates.json";

/** A registered source. One per repository, because moving the pin is what an update is. */
export type RegisteredSource = {
  /** `owner/repo`. The handle IS the id: a second pin on the same repository is a moved pin. */
  id: string;
  owner: string;
  repo: string;
  /** A commit, never a branch. A branch is a name somebody else can repoint after you read it. */
  sha: string;
  registeredBy: string;
  registeredAt: Date;
};

export type CatalogueOrigin =
  | { kind: "directory"; filename: string }
  | { kind: "source"; sourceId: string; sha: string; path: string };

export type CatalogueEntry = {
  /** The document's own slug, not the filename. The filename names the file only. */
  slug: string;
  digest: string;
  document: BotTemplate;
  origin: CatalogueOrigin;
};

/** A file this listing passed over, named so that somebody can go and fix it. */
export type CatalogueSkip = {
  /** The filename or the path in the repository, so the sentence points at a file. */
  where: string;
  /** The parser's own code where there is one, or a word from this file where there is not. */
  reason: string;
  message: string;
};

export type CatalogueListing = {
  entries: CatalogueEntry[];
  skipped: CatalogueSkip[];
};

/**
 * Why the catalogue would not do something.
 *
 * One error class over a union rather than a class each, because every one of these becomes a status
 * code and a sentence in `routes.ts` and a caller wants one thing to catch. `TemplateRefusedError`
 * stays what it is: that one is about a document, this one is about a source or a setting.
 */
export type CatalogueRefusal =
  | "not_admin"
  | "bad_handle"
  | "not_allowlisted"
  | "bad_ref"
  | "not_registered"
  | "bad_manifest"
  | "too_many_files"
  | "too_large"
  | "installers_floor";

export class CatalogueRefusedError extends Error {
  readonly reason: CatalogueRefusal;
  constructor(reason: CatalogueRefusal, message: string) {
    super(message);
    this.name = "CatalogueRefusedError";
    this.reason = reason;
  }
}

/**
 * How this file reaches the network, so that a test does not.
 *
 * Injected rather than closed over the global, because every interesting property here — the caps,
 * the refusals, the skip that is not fatal — is about what a source sends back, and a test that
 * proved them against `raw.githubusercontent.com` would be proving them against whatever that host
 * happened to serve that morning.
 */
export type TemplateFetch = (url: string) => Promise<Response>;

function isYamlFile(name: string): boolean {
  return name.endsWith(".yaml") || name.endsWith(".yml");
}

function skipFor(where: string, error: unknown): CatalogueSkip {
  if (error instanceof TemplateRefusedError) {
    return { where, reason: error.reason, message: error.message };
  }
  return { where, reason: "unreadable", message: String(error) };
}

function announce(skip: CatalogueSkip, type: string): void {
  console.warn(
    JSON.stringify({
      type,
      where: skip.where,
      reason: skip.reason,
      message: skip.message,
    }),
  );
}

/**
 * Fold one parsed file into a listing, refusing a second claim on a slug that is taken.
 *
 * First taker keeps, which is the resolution the package sync already chose and the one the import
 * path chooses for skill slugs. The alternative — the last file read wins — makes what a gallery
 * shows depend on the order a directory happened to come back in.
 */
async function collect(
  listing: CatalogueListing,
  where: string,
  source: string,
  origin: CatalogueOrigin,
): Promise<void> {
  let document: BotTemplate;
  try {
    document = parseBotTemplate(source);
  } catch (error) {
    const skip = skipFor(where, error);
    listing.skipped.push(skip);
    announce(skip, "template-skipped");
    return;
  }

  const slug = document.template.slug;
  if (listing.entries.some((entry) => entry.slug === slug)) {
    const skip: CatalogueSkip = {
      where,
      reason: "duplicate_slug",
      message: `Another file in this catalogue already calls itself "${slug}", and it keeps the name.`,
    };
    listing.skipped.push(skip);
    announce(skip, "template-skipped");
    return;
  }

  listing.entries.push({
    slug,
    digest: await botTemplateDigest(document),
    document,
    origin,
  });
}

/**
 * Everything the in-box directory holds, and everything in it that could not be read.
 *
 * A directory that is not there is reported rather than thrown. `OPENBOT_TEMPLATE_DIR` is resolved
 * from `server/`, so a deployment running the process from somewhere else, or one that mounted a
 * volume that has not appeared yet, points at nothing — and a gallery that is empty is a far better
 * answer to that than an API that will not start.
 */
export async function loadTemplateDirectory(
  directory: string,
): Promise<CatalogueListing> {
  const listing: CatalogueListing = { entries: [], skipped: [] };

  let filenames: string[];
  try {
    filenames = (await readdir(directory)).filter(isYamlFile).sort();
  } catch (error) {
    const skip: CatalogueSkip = {
      where: directory,
      reason: "unreadable",
      message: `The template directory could not be read: ${String(error)}`,
    };
    listing.skipped.push(skip);
    announce(skip, "template-directory-unreadable");
    return listing;
  }

  for (const filename of filenames) {
    const path = join(directory, filename);
    try {
      /*
       * Measured before it is read. The parser's document ceiling refuses an oversized file, but
       * only once the whole of it is a string in this process, and a directory can be a mount
       * somebody else writes into.
       */
      const { size } = await stat(path);
      if (size > TEMPLATE_LIMITS.DOCUMENT_BYTES) {
        const skip: CatalogueSkip = {
          where: filename,
          reason: "too_large",
          message: `This file is ${size} bytes, and a template may be at most ${TEMPLATE_LIMITS.DOCUMENT_BYTES}.`,
        };
        listing.skipped.push(skip);
        announce(skip, "template-skipped");
        continue;
      }
      await collect(listing, filename, await readFile(path, "utf8"), {
        kind: "directory",
        filename,
      });
    } catch (error) {
      const skip = skipFor(filename, error);
      listing.skipped.push(skip);
      announce(skip, "template-skipped");
    }
  }

  return listing;
}

/**
 * A path a manifest may name.
 *
 * Every segment is checked rather than the string scanned for `..`, because the question is not
 * whether the path contains a sequence but whether it is a plain relative path under the repository
 * root. A leading slash, a `..`, a backslash, an empty segment and a query string all fail this, and
 * they fail it before the value is put anywhere near a URL.
 */
function isSafeSourcePath(path: string): boolean {
  if (path.length === 0 || path.length > SOURCE_LIMITS.PATH_LENGTH) {
    return false;
  }
  if (!isYamlFile(path)) return false;
  /*
   * A leading dot is refused for every segment rather than `.` and `..` being named, which covers
   * both of those and takes `.git` and `.github` with them. A manifest has no business naming a file
   * under a dot directory, and a rule that enumerated the two traversal spellings would be a rule to
   * extend the next time somebody found a third.
   */
  return path
    .split("/")
    .every(
      (segment) =>
        /^[A-Za-z0-9._-]+$/.test(segment) && !segment.startsWith("."),
    );
}

/**
 * The address a pinned file lives at.
 *
 * Assembled from values that have already been through `OWNER`, `REPO`, `COMMIT_SHA` and
 * `isSafeSourcePath`, which is why nothing is escaped here: the charsets are the escaping, and they
 * are checked at the two doors — registration and the manifest — rather than at this one, where a
 * mistake would be a fetch that has already been decided on.
 */
function rawUrl(source: RegisteredSource, path: string): string {
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.sha}/${path}`;
}

/** How many bytes a single listing may still read. Shared across the manifest and every file. */
type Budget = { remaining: number };

/**
 * One document off a source, or null because that document is this source's problem.
 *
 * The two failure kinds are deliberately not the same. A file that 404s or comes back as an error
 * page is one author's mistake in one repository and is skipped and named, exactly as a malformed
 * file in the directory is. Running out of the byte budget is not a mistake in a file, it is the
 * source exceeding what this deployment agreed to read, so it throws and the whole listing refuses.
 */
async function readWithinBudget(
  fetcher: TemplateFetch,
  url: string,
  budget: Budget,
  cap: number,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (error) {
    console.warn(
      JSON.stringify({
        type: "template-source-unreachable",
        url,
        error: String(error),
      }),
    );
    return null;
  }
  if (!response.ok) {
    console.warn(
      JSON.stringify({
        type: "template-source-unreachable",
        url,
        status: response.status,
      }),
    );
    return null;
  }

  /*
   * The declared length first, so an oversized body is refused before it is in memory, and the
   * measured length after, because a header is a claim and some responses carry no header at all.
   */
  const allowed = Math.min(cap, budget.remaining);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > allowed) {
    throw new CatalogueRefusedError(
      "too_large",
      `${url} is larger than this deployment will read from a source.`,
    );
  }

  const body = await response.text();
  const size = Buffer.byteLength(body, "utf8");
  if (size > allowed) {
    throw new CatalogueRefusedError(
      "too_large",
      `${url} is larger than this deployment will read from a source.`,
    );
  }
  budget.remaining -= size;
  return body;
}

/**
 * The names a source publishes, refused whole rather than trimmed.
 *
 * A manifest listing more files than the cap is not a manifest this deployment reads the first two
 * hundred of: whichever files that silently dropped would be missing from a gallery with nothing
 * saying so, and which ones survived would depend on the order the source wrote them in.
 */
function parseManifest(body: string): string[] {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    throw new CatalogueRefusedError(
      "bad_manifest",
      `${SOURCE_MANIFEST} is not valid JSON.`,
    );
  }

  const templates = (document as { templates?: unknown } | null)?.templates;
  if (!Array.isArray(templates)) {
    throw new CatalogueRefusedError(
      "bad_manifest",
      `${SOURCE_MANIFEST} must be an object with a "templates" array of paths.`,
    );
  }
  if (templates.length > SOURCE_LIMITS.FILES) {
    throw new CatalogueRefusedError(
      "too_many_files",
      `${SOURCE_MANIFEST} names ${templates.length} files, and this deployment reads at most ${SOURCE_LIMITS.FILES} from one source.`,
    );
  }
  return templates.map((entry) => (typeof entry === "string" ? entry : ""));
}

/**
 * Everything one pinned source holds.
 *
 * Server-side, always, which is the reason this function exists at all rather than the browser
 * fetching the raw URLs itself: a gallery rendered from the browser would give every person looking
 * at it a third-party origin they did not choose, and would show the source each viewer's address.
 */
export async function loadTemplateSource(
  source: RegisteredSource,
  fetcher: TemplateFetch,
): Promise<CatalogueListing> {
  const listing: CatalogueListing = { entries: [], skipped: [] };
  const budget: Budget = { remaining: SOURCE_LIMITS.TOTAL_BYTES };

  const manifest = await readWithinBudget(
    fetcher,
    rawUrl(source, SOURCE_MANIFEST),
    budget,
    SOURCE_LIMITS.MANIFEST_BYTES,
  );
  if (manifest === null) {
    const skip: CatalogueSkip = {
      where: SOURCE_MANIFEST,
      reason: "no_manifest",
      message: `${source.id} at ${source.sha} publishes no ${SOURCE_MANIFEST}, so this deployment does not know what it holds.`,
    };
    listing.skipped.push(skip);
    announce(skip, "template-source-skipped");
    return listing;
  }

  for (const path of parseManifest(manifest)) {
    if (!isSafeSourcePath(path)) {
      const skip: CatalogueSkip = {
        where: path,
        reason: "bad_path",
        message:
          "A manifest entry must be a plain relative path to a YAML file inside the repository.",
      };
      listing.skipped.push(skip);
      announce(skip, "template-source-skipped");
      continue;
    }

    const body = await readWithinBudget(
      fetcher,
      rawUrl(source, path),
      budget,
      TEMPLATE_LIMITS.DOCUMENT_BYTES,
    );
    if (body === null) {
      const skip: CatalogueSkip = {
        where: path,
        reason: "unreachable",
        message: `${path} is named in ${SOURCE_MANIFEST} and could not be read at ${source.sha}.`,
      };
      listing.skipped.push(skip);
      announce(skip, "template-source-skipped");
      continue;
    }

    await collect(listing, path, body, {
      kind: "source",
      sourceId: source.id,
      sha: source.sha,
      path,
    });
  }

  return listing;
}

export type TemplateCatalogueOptions = {
  /** `OPENBOT_TEMPLATE_DIR`, resolved from `server/` exactly as `TENANT_PACKAGE_DIR` is. */
  directory: string;
  /** `OPENBOT_TEMPLATE_SOURCES`, as handle keys. Empty is the shipped state and means no source. */
  allowedSources: ReadonlySet<string>;
  /** `OPENBOT_TEMPLATE_INSTALLERS`. The floor, which an administrator may raise and never lower. */
  installerFloor: TemplateInstallers;
  /** Defaults to the global. Given by a test, and by nothing else. */
  fetch?: TemplateFetch;
};

export type TemplateCatalogue = {
  /** What the in-box directory holds, with whatever it could not read alongside it. */
  directory(): Promise<CatalogueListing>;
  /** One in-box template by its own slug, or null. */
  fromDirectory(slug: string): Promise<CatalogueEntry | null>;

  /** The `owner/repo` values this deployment's environment permits. Never widened here. */
  allowedSources(): string[];
  /** The sources an administrator has actually registered. Empty until one does. */
  sources(): RegisteredSource[];
  registerSource(
    actor: AgentActor,
    input: { handle: string; sha: string },
  ): RegisteredSource;
  forgetSource(actor: AgentActor, id: string): boolean;
  /** What one registered source holds at its pin. Fetched server-side. */
  fromSource(id: string): Promise<CatalogueListing>;
  fromSourceBySlug(id: string, slug: string): Promise<CatalogueEntry | null>;

  installers(): TemplateInstallers;
  /** Raise the setting. Lowering it below the environment's floor refuses. */
  setInstallers(
    actor: AgentActor,
    value: TemplateInstallers,
  ): TemplateInstallers;
};

function requireAdministrator(actor: AgentActor, act: string): void {
  /*
   * Gated in the store as well as at the route, and for the reason `store.ts` gives about drafts:
   * there will be more than one route eventually and one of them will be written by somebody who
   * did not read the guard on the others. Under `OPENBOT_SINGLE_USER` this is vacuous because
   * everybody is the administrator, which the consent screen says out loud rather than papering over.
   */
  if (actor.role !== "admin") {
    throw new CatalogueRefusedError(
      "not_admin",
      `Only an administrator may ${act}.`,
    );
  }
}

export function createTemplateCatalogue(
  options: TemplateCatalogueOptions,
): TemplateCatalogue {
  const fetcher: TemplateFetch = options.fetch ?? ((url) => fetch(url));

  /*
   * REGISTERED SOURCES LIVE FOR AS LONG AS THIS PROCESS DOES, and that is a known gap rather than a
   * design: persisting them needs a table, and the schema for this feature is owned elsewhere. The
   * consequence to be aware of is that a restart forgets the pin and the gallery falls back to the
   * in-box directory, which is the safe direction to fail — a deployment that has forgotten a source
   * fetches nothing, where one that had remembered a stale pin would fetch on somebody's behalf
   * without them having asked again.
   */
  const registry = new Map<string, RegisteredSource>();

  /*
   * Keyed by the pin, never by the repository, and that is what makes it correct to cache at all: a
   * commit sha names one immutable tree, so a listing read at that sha cannot go stale. Moving the
   * pin is the only update mechanism, and it produces a different key rather than an invalidation
   * somebody has to remember to perform.
   */
  const listings = new Map<string, Promise<CatalogueListing>>();

  let directoryListing: Promise<CatalogueListing> | undefined;
  let installers = options.installerFloor;

  function loadDirectory(): Promise<CatalogueListing> {
    if (!directoryListing) {
      directoryListing = loadTemplateDirectory(options.directory);
    }
    return directoryListing;
  }

  function sourceOrRefuse(id: string): RegisteredSource {
    const source = registry.get(id.trim().toLowerCase());
    if (!source) {
      throw new CatalogueRefusedError(
        "not_registered",
        `No template source called "${id}" is registered on this deployment.`,
      );
    }
    return source;
  }

  /*
   * A function rather than a method reached through `this`, because the by-slug read calls it and a
   * caller who destructured the store — which every route file in this codebase does — would
   * otherwise get an undefined receiver at the second call rather than at the first.
   */
  async function fromSource(id: string): Promise<CatalogueListing> {
    /*
     * `async` so that an unregistered id arrives at the caller as a rejected promise rather than as
     * a synchronous throw out of a function whose type says it returns one. A route handler that
     * awaited this would see the difference only in whether its `try` was in the right place.
     */
    const source = sourceOrRefuse(id);
    const key = `${source.id}@${source.sha}`;
    let listing = listings.get(key);
    if (!listing) {
      /*
       * A failed listing is not cached. `loadTemplateSource` throws only when the source broke this
       * deployment's caps or published something that is not a manifest, and both of those are
       * conditions somebody goes and fixes; a rejected promise left in the map would answer every
       * later request with the failure that happened once.
       */
      listing = loadTemplateSource(source, fetcher).catch((error: unknown) => {
        listings.delete(key);
        throw error;
      });
      listings.set(key, listing);
    }
    return listing;
  }

  return {
    directory: loadDirectory,

    async fromDirectory(slug) {
      const listing = await loadDirectory();
      return listing.entries.find((entry) => entry.slug === slug) ?? null;
    },

    allowedSources() {
      return [...options.allowedSources].sort();
    },

    sources() {
      return [...registry.values()].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      );
    },

    registerSource(actor, input) {
      requireAdministrator(actor, "register a template source");

      const handle = parseSourceHandle(input.handle);
      if (!handle) {
        throw new CatalogueRefusedError(
          "bad_handle",
          `"${input.handle}" is not a GitHub owner/repo.`,
        );
      }
      const id = sourceHandleKey(handle);

      /*
       * The allowlist is checked here and is not checkable anywhere else. It is the whole of the
       * answer to "which third parties may this deployment talk to", it comes from the environment,
       * and no screen may widen it — the `INITIAL_ADMIN_EMAILS` shape, where the configuration
       * decides and the product renders the decision. An administrator who wants another repository
       * changes the deployment's environment, which is a different act with a different audience.
       */
      if (!options.allowedSources.has(id)) {
        throw new CatalogueRefusedError(
          "not_allowlisted",
          `"${id}" is not named in OPENBOT_TEMPLATE_SOURCES, so this deployment will not fetch from it. Add it to the deployment's environment first.`,
        );
      }

      /*
       * A pin, never a branch. `main` is a name whoever owns that repository can repoint after an
       * administrator read the files, which turns a reviewed catalogue into an update channel — the
       * mechanism behind the Cyberhaven and Coze compromises, and the one thing this design has no
       * version of.
       */
      const sha = input.sha.trim().toLowerCase();
      if (!COMMIT_SHA.test(sha)) {
        throw new CatalogueRefusedError(
          "bad_ref",
          "A template source is pinned to a full 40-character commit sha. A branch or a tag is a name somebody else can repoint after you have read the files.",
        );
      }

      const source: RegisteredSource = {
        id,
        owner: handle.owner,
        repo: handle.repo,
        sha,
        registeredBy: actor.id,
        registeredAt: new Date(),
      };
      registry.set(id, source);
      return source;
    },

    forgetSource(actor, id) {
      requireAdministrator(actor, "forget a template source");
      /*
       * The cached listing is deliberately left where it is. It is keyed by the pin, so it is not
       * reachable without a registration naming that pin again, and dropping it would mean a
       * deployment that forgot and re-registered the same source paid for the whole fetch twice.
       */
      return registry.delete(id.trim().toLowerCase());
    },

    fromSource,

    async fromSourceBySlug(id, slug) {
      const listing = await fromSource(id);
      return listing.entries.find((entry) => entry.slug === slug) ?? null;
    },

    installers() {
      return installers;
    },

    setInstallers(actor, value) {
      requireAdministrator(actor, "change who may install a template");
      /*
       * UNDEMOTABLE. The environment sets a floor and a screen may only raise it, which is the
       * property that makes the variable worth setting at all: an operator who wrote
       * `OPENBOT_TEMPLATE_INSTALLERS=admin` into their deployment's configuration has to be able to
       * rely on it holding, and a restriction that any administrator can click away is a restriction
       * that will be clicked away by whoever finds it inconvenient at the time. The screen renders
       * the disabled control and says where the floor came from, the same way it does for an
       * administrator named in `INITIAL_ADMIN_EMAILS`.
       */
      if (options.installerFloor === "admin" && value === "anyone") {
        throw new CatalogueRefusedError(
          "installers_floor",
          "This deployment's environment sets OPENBOT_TEMPLATE_INSTALLERS=admin, and that floor cannot be lowered here. Change the deployment's configuration instead.",
        );
      }
      installers = value;
      return installers;
    },
  };
}

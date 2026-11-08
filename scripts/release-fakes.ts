/**
 * Stand-ins for `gh` and `curl`, for running the release shell scripts against a pretend
 * repository. Each records its calls, one argument list per line, so a test can say exactly what
 * a script would have done to a release.
 *
 * The pretend repository's Latest release lives in a file: `gh release edit <tag> --latest`
 * moves it, and `gh api repos/<repo>/releases/latest` reads it, answering 404 when it is empty
 * and a server error when it says `error`.
 *
 * The release's assets live in another: `gh release upload` adds each file's name, refusing a name
 * the release already has unless given `--clobber`, as gh does, and
 * `gh release view <tag> --json assets` lists them, one per line, as its `--jq` would. Each upload
 * also keeps the file itself, and `gh release download <tag> --pattern <name> --dir <dir>` gives it
 * back, failing as gh does when no asset has that name.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GH = `#!/usr/bin/env bash
printf '%s\\n' "gh $*" >> "$FAKE_LOG"
if [ "$1" = api ] && [[ "$2" == repos/*/releases/latest ]]; then
  latest="$(cat "$FAKE_STATE/latest")"
  if [ -z "$latest" ]; then
    echo '{"message":"Not Found"}'
    echo 'gh: Not Found (HTTP 404)' >&2
    exit 1
  fi
  if [ "$latest" = error ]; then
    echo 'gh: Server Error (HTTP 502)' >&2
    exit 1
  fi
  echo "$latest"
  exit 0
fi
if [ "$1 $2" = "release edit" ]; then
  for arg in "$@"; do
    if [ "$arg" = --latest ]; then printf '%s' "$3" > "$FAKE_STATE/latest"; fi
  done
fi
if [ "$1 $2" = "release upload" ]; then
  shift 3
  clobber=false
  files=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -R) shift ;;
      --clobber) clobber=true ;;
      --*) ;;
      *) files+=("$1") ;;
    esac
    shift
  done
  # As gh does: without --clobber, a name the release already has fails the whole upload before
  # anything is sent. A name in race/ is attached by another run just before this one looks.
  for file in "\${files[@]}"; do
    name="$(basename "$file")"
    if [ -f "$FAKE_STATE/fail/$name" ]; then
      echo "gh: Server Error (HTTP 502)" >&2
      exit 1
    fi
    if [ -f "$FAKE_STATE/race/$name" ]; then
      mv "$FAKE_STATE/race/$name" "$FAKE_STATE/files/$name"
      echo "$name" >> "$FAKE_STATE/assets"
    fi
    if [ "$clobber" = false ] && grep -qxF "$name" "$FAKE_STATE/assets"; then
      echo "asset under the same name already exists: [$name]" >&2
      exit 1
    fi
  done
  for file in "\${files[@]}"; do
    basename "$file" >> "$FAKE_STATE/assets"
    cp "$file" "$FAKE_STATE/files/$(basename "$file")"
  done
fi
if [ "$1 $2" = "release download" ]; then
  pattern=""
  dir="."
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --pattern) pattern="$2"; shift ;;
      --dir) dir="$2"; shift ;;
    esac
    shift
  done
  if [ ! -f "$FAKE_STATE/files/$pattern" ]; then
    echo 'no assets match the file pattern' >&2
    exit 1
  fi
  mkdir -p "$dir"
  cp "$FAKE_STATE/files/$pattern" "$dir/$pattern"
fi
if [ "$1 $2" = "release view" ] && [[ " $* " == *" --json assets "* ]]; then
  sort -u "$FAKE_STATE/assets"
fi
exit 0
`;

const CURL = `#!/usr/bin/env bash
printf '%s\\n' "curl $*" >> "$FAKE_LOG"
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then out="$2"; shift; fi
  shift
done
latest="$(cat "$FAKE_STATE/latest")"
feed="$FAKE_STATE/feed-$latest.json"
if [ -n "$latest" ] && [ -f "$feed" ]; then cp "$feed" "$out"; exit 0; fi
# With no feed set for it, the Latest release serves the latest.json uploaded to it.
if [ -n "$latest" ] && [ -f "$FAKE_STATE/files/latest.json" ]; then
  cp "$FAKE_STATE/files/latest.json" "$out"
  exit 0
fi
exit 22
`;

export type FakeRepo = {
  dir: string;
  env: Record<string, string>;
  /** Every gh and curl call so far, one per line. */
  calls(): string[];
  latest(): string;
  /**
   * What `releases/latest/download/latest.json` serves while `tag` is Latest. Without one, it
   * serves the latest.json uploaded to the release.
   */
  feed(tag: string, json: unknown): void;
  /** Names already on the release, as an earlier run or the other signing run left them. */
  attach(...names: string[]): void;
  /** A file already on the release, with what it holds. */
  attachFile(name: string, content: string): void;
  /**
   * Another run, such as a signing run, attaches `name` holding `content` the moment the next upload
   * of that name looks at the release: after the caller read the release, before its upload lands.
   */
  race(name: string, content: string): void;
  /** Every upload of `name` fails, as a server error would fail it. */
  failUpload(name: string): void;
  /** What the release holds under `name`, as the last upload of it left it. */
  file(name: string): string;
  assets(): string[];
  cleanup(): void;
};

export function fakeRepo(latest: string): FakeRepo {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  mkdirSync(bin);
  mkdirSync(state);
  mkdirSync(join(state, "files"));
  mkdirSync(join(state, "race"));
  mkdirSync(join(state, "fail"));
  writeFileSync(join(bin, "gh"), GH);
  writeFileSync(join(bin, "curl"), CURL);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  writeFileSync(join(state, "latest"), latest);
  writeFileSync(join(state, "assets"), "");
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  return {
    dir,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_LOG: log,
      FAKE_STATE: state,
      GITHUB_REPOSITORY: "CopilotKit/OpenBot",
      GH_TOKEN: "fake",
    },
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    latest: () => readFileSync(join(state, "latest"), "utf8"),
    feed: (tag, json) =>
      writeFileSync(join(state, `feed-${tag}.json`), JSON.stringify(json)),
    attach: (...names) =>
      writeFileSync(
        join(state, "assets"),
        readFileSync(join(state, "assets"), "utf8") +
          names.map((name) => `${name}\n`).join(""),
      ),
    attachFile: (name, content) => {
      writeFileSync(join(state, "files", name), content);
      writeFileSync(
        join(state, "assets"),
        `${readFileSync(join(state, "assets"), "utf8")}${name}\n`,
      );
    },
    race: (name, content) => writeFileSync(join(state, "race", name), content),
    failUpload: (name) => writeFileSync(join(state, "fail", name), ""),
    file: (name) => readFileSync(join(state, "files", name), "utf8"),
    assets: () =>
      [
        ...new Set(
          readFileSync(join(state, "assets"), "utf8")
            .split("\n")
            .filter(Boolean),
        ),
      ].sort(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Every platform a stable release's latest.json lists (scripts/release-update-feed.sh). */
export const FEED_PLATFORMS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "windows-x86_64",
] as const;

/** A latest.json for `version` listing `platforms`, each with a URL and a signature. */
export function feedFor(
  version: string,
  platforms: readonly string[] = FEED_PLATFORMS,
) {
  return {
    version,
    platforms: Object.fromEntries(
      platforms.map((platform) => [
        platform,
        {
          url: `https://example.test/${platform}`,
          signature: `sig-${platform}`,
        },
      ]),
    ),
  };
}

/** Runs a script with the fakes first on PATH. */
export function runScript(
  script: string,
  args: string[],
  repo: FakeRepo,
  env: Record<string, string>,
  cwd: string,
) {
  const result = Bun.spawnSync(["bash", script, ...args], {
    cwd,
    env: { ...process.env, ...repo.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString() + result.stderr.toString(),
  };
}

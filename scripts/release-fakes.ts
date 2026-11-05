/**
 * Stand-ins for `gh` and `curl`, for running the release shell scripts against a pretend
 * repository. Each records its calls, one argument list per line, so a test can say exactly what
 * a script would have done to a release.
 *
 * The pretend repository's Latest release lives in a file: `gh release edit <tag> --latest`
 * moves it, and `gh api repos/<repo>/releases/latest` reads it, answering 404 when it is empty
 * and a server error when it says `error`.
 *
 * The release's assets live in another: `gh release upload` adds each file's name, and
 * `gh release view <tag> --json assets` lists them, one per line, as its `--jq` would.
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
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -R) shift ;;
      --*) ;;
      *) basename "$1" >> "$FAKE_STATE/assets" ;;
    esac
    shift
  done
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
exit 22
`;

export type FakeRepo = {
  dir: string;
  env: Record<string, string>;
  /** Every gh and curl call so far, one per line. */
  calls(): string[];
  latest(): string;
  /** What `releases/latest/download/latest.json` serves while `tag` is Latest. */
  feed(tag: string, json: unknown): void;
  /** Names already on the release, as an earlier run or the other signing run left them. */
  attach(...names: string[]): void;
  assets(): string[];
  cleanup(): void;
};

export function fakeRepo(latest: string): FakeRepo {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  mkdirSync(bin);
  mkdirSync(state);
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

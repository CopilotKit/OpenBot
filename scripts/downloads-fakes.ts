/**
 * Stand-ins for `gh` and `aws`, for running scripts/downloads-sync.sh against a pretend repository
 * and a pretend bucket. Each records its calls, one argument list per line.
 *
 * They answer as the real CLIs do, as observed against the real repository and bucket:
 * - `gh api repos/<repo>/releases/latest` serves the release marked Latest, or 404s when none is,
 *   and `gh release view <tag> --json ...` prints only the fields asked for, each asset with its
 *   `sha256:` digest, or fails with `release not found`. Both apply `--jq` when given.
 * - `gh release download <tag> --pattern <name> --dir <dir>` fails when nothing matches or the file
 *   is already there.
 * - `aws s3api head-object` fails with exit 254 and `(404)` for a missing key, and reports
 *   ChecksumSHA256 only with `--checksum-mode ENABLED` and only for an object uploaded with one.
 * - `aws s3api put-object --checksum-sha256` refuses a body that does not hash to it (BadDigest).
 * - `aws cloudfront create-invalidation` answers with the new invalidation's Id.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SHA = `sha_hex() { openssl dgst -sha256 -binary "$1" | od -An -v -tx1 | tr -d ' \\n'; }
sha_b64() { openssl dgst -sha256 -binary "$1" | openssl base64 -A; }`;

const GH = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "gh $*" >> "$FAKE_LOG"
${SHA}
jq_flag() {
  local prev=""
  for arg in "$@"; do
    if [ "$prev" = --jq ]; then printf '%s' "$arg"; return; fi
    prev="$arg"
  done
}
emit() {
  local filter
  filter="$(jq_flag "$@")"
  if [ -n "$filter" ]; then jq -r "$filter"; else cat; fi
}
release_json() {
  local tag="$1" dir="$FAKE_STATE/releases/$1" assets='[]' name
  if [ -d "$dir/assets" ]; then
    for file in "$dir/assets"/*; do
      [ -e "$file" ] || continue
      name="$(basename "$file")"
      assets="$(jq -c --arg name "$name" --arg digest "sha256:$(sha_hex "$file")" \\
        --argjson size "$(wc -c < "$file" | tr -d ' ')" \\
        '. + [{name: $name, digest: $digest, size: $size, state: "uploaded"}]' <<<"$assets")"
    done
  fi
  jq -c --arg tag "$tag" --argjson assets "$assets" '. + {tagName: $tag, assets: $assets}' "$dir/release.json"
}
if [ "$1" = api ] && [[ "$2" == repos/*/releases/latest ]]; then
  latest="$(cat "$FAKE_STATE/latest")"
  if [ -z "$latest" ]; then
    echo '{"message":"Not Found"}'
    echo 'gh: Not Found (HTTP 404)' >&2
    exit 1
  fi
  release_json "$latest" | jq -c '{tag_name: .tagName, draft: .isDraft, prerelease: .isPrerelease}' | emit "$@"
  exit 0
fi
if [ "$1 $2" = "release view" ]; then
  tag="$3"
  if [ ! -d "$FAKE_STATE/releases/$tag" ]; then
    echo 'release not found' >&2
    exit 1
  fi
  fields=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = --json ]; then fields="$arg"; fi
    prev="$arg"
  done
  release_json "$tag" | jq -c --arg fields "$fields" '. as $r | ($fields | split(",")) | map({(.): $r[.]}) | add' | emit "$@"
  exit 0
fi
if [ "$1 $2" = "release download" ]; then
  tag="$3"
  shift 3
  pattern=""
  dir="."
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -p|--pattern) pattern="$2"; shift ;;
      -D|--dir) dir="$2"; shift ;;
      -R) shift ;;
    esac
    shift
  done
  matched=0
  for file in "$FAKE_STATE/releases/$tag/assets"/*; do
    [ -e "$file" ] || continue
    name="$(basename "$file")"
    # shellcheck disable=SC2053
    if [[ "$name" == $pattern ]]; then
      if [ -e "$dir/$name" ]; then
        echo "$dir/$name already exists (use \\\`--clobber\\\` to overwrite file or \\\`--skip-existing\\\` to skip file)" >&2
        exit 1
      fi
      mkdir -p "$dir"
      cp "$file" "$dir/$name"
      matched=1
    fi
  done
  if [ "$matched" = 0 ]; then
    echo 'no assets match the file pattern' >&2
    exit 1
  fi
  exit 0
fi
if [ "$1 $2" = "release edit" ]; then
  for arg in "$@"; do
    if [ "$arg" = --latest ]; then printf '%s' "$3" > "$FAKE_STATE/latest"; fi
  done
  exit 0
fi
if [ "$1 $2" = "workflow run" ]; then
  exit 0
fi
echo "fake gh: unexpected call: gh $*" >&2
exit 1
`;

const AWS = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "aws $*" >> "$FAKE_LOG"
${SHA}
service="$1"
command="$2"
shift 2
bucket=""; key=""; body=""; type=""; cache=""; checksum=""; mode=""; distribution=""; paths=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bucket) bucket="$2"; shift ;;
    --key) key="$2"; shift ;;
    --body) body="$2"; shift ;;
    --content-type) type="$2"; shift ;;
    --cache-control) cache="$2"; shift ;;
    --checksum-sha256) checksum="$2"; shift ;;
    --checksum-mode) mode="$2"; shift ;;
    --distribution-id) distribution="$2"; shift ;;
    --paths) paths+=("$2"); shift ;;
    --output) shift ;;
    *) echo "fake aws: unexpected argument $1" >&2; exit 252 ;;
  esac
  shift
done
object="$FAKE_STATE/s3/$bucket/$key"
meta="$FAKE_STATE/s3-meta/$bucket/$key.json"
case "$service $command" in
  "s3api head-object")
    if [ -f "$FAKE_STATE/denied" ]; then
      printf '\\naws: [ERROR]: An error occurred (403) when calling the HeadObject operation: Forbidden\\n' >&2
      exit 254
    fi
    if [ ! -f "$object" ]; then
      printf '\\naws: [ERROR]: An error occurred (404) when calling the HeadObject operation: Not Found\\n' >&2
      exit 254
    fi
    jq --arg mode "$mode" --argjson size "$(wc -c < "$object" | tr -d ' ')" '
      {AcceptRanges: "bytes", ContentLength: $size, ETag: "\\"etag\\"", ServerSideEncryption: "AES256", Metadata: {}}
      + (if .CacheControl != "" then {CacheControl: .CacheControl} else {} end)
      + {ContentType: (if .ContentType != "" then .ContentType else "binary/octet-stream" end)}
      + (if $mode == "ENABLED" and .ChecksumSHA256 != "" then {ChecksumSHA256: .ChecksumSHA256, ChecksumType: "FULL_OBJECT"} else {} end)
    ' "$meta"
    ;;
  "s3api put-object")
    if [ -n "$checksum" ] && [ "$checksum" != "$(sha_b64 "$body")" ]; then
      printf '\\naws: [ERROR]: An error occurred (BadDigest) when calling the PutObject operation: The SHA256 you specified did not match the calculated checksum.\\n' >&2
      exit 254
    fi
    mkdir -p "$(dirname "$object")" "$(dirname "$meta")"
    cp "$body" "$object"
    jq -n --arg type "$type" --arg cache "$cache" --arg checksum "$checksum" \\
      '{ContentType: $type, CacheControl: $cache, ChecksumSHA256: $checksum}' > "$meta"
    jq -n --arg checksum "$checksum" '{ETag: "\\"etag\\"", ServerSideEncryption: "AES256", VersionId: "v1"}
      + (if $checksum != "" then {ChecksumSHA256: $checksum, ChecksumType: "FULL_OBJECT"} else {} end)'
    ;;
  "cloudfront create-invalidation")
    n=$(( $(wc -l < "$FAKE_STATE/invalidations" | tr -d ' ') + 1 ))
    printf '%s %s\\n' "$distribution" "\${paths[*]}" >> "$FAKE_STATE/invalidations"
    jq -n --arg id "I$n" --arg d "$distribution" --args '{
      Location: "https://cloudfront.amazonaws.com/2020-05-31/distribution/\\($d)/invalidation/\\($id)",
      Invalidation: {Id: $id, Status: "InProgress", InvalidationBatch: {Paths: {Quantity: ($ARGS.positional | length), Items: $ARGS.positional}}}
    }' "\${paths[@]}"
    ;;
  *)
    echo "fake aws: unexpected call: aws $service $command" >&2
    exit 252
    ;;
esac
`;

export type S3Object = {
  content: string;
  cacheControl: string;
  contentType: string;
  /** Whether S3 holds a SHA-256 for it, as it does for an object uploaded with one. */
  sha256: boolean;
};

export type FakeDownloads = {
  env: Record<string, string>;
  /** Every gh and aws call so far, one per line. */
  calls(): string[];
  /** A release and its assets, by name and content. */
  release(
    tag: string,
    assets: Record<string, string>,
    flags?: { prerelease?: boolean; draft?: boolean },
  ): void;
  setLatest(tag: string): void;
  /** Everything in the bucket, by key. */
  bucket(): Record<string, S3Object>;
  /** Puts an object there as some other hand would have: a console upload has no SHA-256. */
  seed(key: string, object: S3Object): void;
  remove(key: string): void;
  /** From now on every read of the bucket is refused, as it is for credentials without access. */
  deny(): void;
  /** Each invalidation, as "<distribution> <paths>". */
  invalidations(): string[];
  cleanup(): void;
};

export const BUCKET = "downloads-bucket";
export const DISTRIBUTION = "EDISTRIBUTION";

export function fakeDownloads(): FakeDownloads {
  const dir = mkdtempSync(join(tmpdir(), "fake-downloads-"));
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  mkdirSync(bin);
  mkdirSync(join(state, "releases"), { recursive: true });
  mkdirSync(join(state, "s3", BUCKET), { recursive: true });
  mkdirSync(join(state, "s3-meta", BUCKET), { recursive: true });
  writeFileSync(join(bin, "gh"), GH);
  writeFileSync(join(bin, "aws"), AWS);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "aws"), 0o755);
  writeFileSync(join(state, "latest"), "");
  writeFileSync(join(state, "invalidations"), "");
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const objects = join(state, "s3", BUCKET);
  const metas = join(state, "s3-meta", BUCKET);

  const keys = (base: string, at = ""): string[] =>
    readdirSync(join(base, at), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? keys(base, join(at, entry.name))
        : [join(at, entry.name)],
    );

  return {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_LOG: log,
      FAKE_STATE: state,
      GITHUB_REPOSITORY: "CopilotKit/OpenBot",
      GH_TOKEN: "fake",
      DOWNLOADS_BUCKET: BUCKET,
      DOWNLOADS_DISTRIBUTION_ID: DISTRIBUTION,
    },
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    release: (tag, assets, flags = {}) => {
      const at = join(state, "releases", tag);
      mkdirSync(join(at, "assets"), { recursive: true });
      writeFileSync(
        join(at, "release.json"),
        JSON.stringify({
          isDraft: flags.draft ?? false,
          isPrerelease: flags.prerelease ?? false,
        }),
      );
      for (const [name, content] of Object.entries(assets))
        writeFileSync(join(at, "assets", name), content);
    },
    setLatest: (tag) => writeFileSync(join(state, "latest"), tag),
    bucket: () =>
      Object.fromEntries(
        keys(objects).map((key) => {
          const meta = JSON.parse(
            readFileSync(join(metas, `${key}.json`), "utf8"),
          );
          return [
            key,
            {
              content: readFileSync(join(objects, key), "utf8"),
              cacheControl: meta.CacheControl,
              contentType: meta.ContentType,
              sha256: meta.ChecksumSHA256 !== "",
            },
          ];
        }),
      ),
    seed: (key, object) => {
      mkdirSync(dirname(join(objects, key)), { recursive: true });
      mkdirSync(dirname(join(metas, key)), { recursive: true });
      writeFileSync(join(objects, key), object.content);
      const sha = object.sha256
        ? new Bun.CryptoHasher("sha256").update(object.content).digest("base64")
        : "";
      writeFileSync(
        join(metas, `${key}.json`),
        JSON.stringify({
          ContentType: object.contentType,
          CacheControl: object.cacheControl,
          ChecksumSHA256: sha,
        }),
      );
    },
    remove: (key) => {
      rmSync(join(objects, key));
      rmSync(join(metas, `${key}.json`));
    },
    deny: () => writeFileSync(join(state, "denied"), ""),
    invalidations: () =>
      readFileSync(join(state, "invalidations"), "utf8")
        .split("\n")
        .filter(Boolean),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

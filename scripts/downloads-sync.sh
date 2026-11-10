#!/usr/bin/env bash
# Mirrors the signed installers of the Latest stable release to downloads.copilotkit.ai.
#
# Run by .github/workflows/downloads-sync.yml: when a stable release becomes Latest
# (scripts/release-make-latest.sh starts it), every six hours in case anything drifted, and by
# hand. The website links to this address, so it serves only installers the signing runs attached,
# and under latest/ only those of the release GitHub calls Latest.
#
# Where each file goes, in the bucket behind the CloudFront distribution:
#   latest/<fixed name>              each installer under its fixed download name
#                                    (scripts/release-download-names.sh), and latest.json; cached
#                                    for five minutes
#   releases/<tag>/<versioned name>  each installer under the name Tauri gave it, container-images.json,
#                                    desktop-images.json and the Mac updater archives; never changes,
#                                    so cached for a year
#
# Env:
#   GITHUB_REPOSITORY and GH_TOKEN  for `gh`
#   DOWNLOADS_BUCKET                the bucket behind the distribution
#   DOWNLOADS_DISTRIBUTION_ID       the CloudFront distribution
#   DOWNLOADS_TAG                   mirror this release's releases/<tag>/ only, a candidate or beta
#                                   included (cached for five minutes, as its signing may replace
#                                   an installer), and leave latest/ alone (default: the Latest
#                                   release, both)
#   DOWNLOADS_PREFIX                put every key under this prefix, such as `smoketest/`, to try
#                                   the sync against the real bucket without changing what it serves
#   DOWNLOADS_URL                   the address the mirrored latest.json names its downloads at
#                                   (default https://downloads.copilotkit.ai)
#   DOWNLOADS_VERIFY_DELAY          seconds between checks of a download the feed names (default 10)
#   and AWS credentials that may read and write the bucket and invalidate the distribution.
#
# latest/latest.json is the release's feed with each platform's download moved here, where this run
# put it (releases/<tag>/<file>); see the comment where it is written.
#
# Running it again changes nothing. Each object's SHA-256, as S3 computed it on upload, is compared
# with the digest GitHub reports for the asset, and only an object that is missing, differs, or has
# other caching headers is uploaded. /latest/* is invalidated only when something under latest/ was.
# Nothing is ever deleted.
#
# A Latest release with no signed installers at all, published before signing attached any, has
# nothing to sync, and the run succeeds without touching AWS. Otherwise it changes nothing and fails
# when the release is a prerelease, a draft or not a stable version, or when it lacks latest.json
# or any installer under its fixed name. On a stable release only the
# signing runs attach those, so their presence is what says each installer is signed. Each
# versioned installer must be the same file as its fixed-name copy, so releases/<tag>/ gets the
# signed build too.
set -euo pipefail
# bash 5.2+ reads an unquoted & in a ${var//pattern/replacement} as the match; the feed rewrite
# needs it literal (bash 3.2, macOS's, has no such option).
shopt -u patsub_replacement 2>/dev/null || true

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must name the repository}"
: "${DOWNLOADS_BUCKET:?DOWNLOADS_BUCKET must name the bucket}"
: "${DOWNLOADS_DISTRIBUTION_ID:?DOWNLOADS_DISTRIBUTION_ID must name the CloudFront distribution}"
bucket="$DOWNLOADS_BUCKET"
prefix="${DOWNLOADS_PREFIX:-}"
tag="${DOWNLOADS_TAG:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
latest_cache='public, max-age=300'
release_cache='public, max-age=31536000, immutable'
downloads_url="${DOWNLOADS_URL:-https://downloads.copilotkit.ai}"
downloads_url="${downloads_url%/}"

if [ -n "$prefix" ] && [[ ! "$prefix" =~ ^[a-z0-9][a-z0-9-]*/$ ]]; then
  echo "::error::DOWNLOADS_PREFIX must be a single lowercase folder ending in /, such as smoketest/."
  exit 1
fi

if [ -z "$tag" ]; then
  mode=latest
  # GitHub's Latest is never a prerelease or a draft. Assigned first: a failure inside a command's
  # argument would not stop the script.
  if ! tag="$(gh api "repos/$GITHUB_REPOSITORY/releases/latest" --jq .tag_name 2>&1)"; then
    echo "::error::Could not read the Latest release, so nothing was mirrored: $tag"
    exit 1
  fi
else
  mode=release
fi

release="$(gh release view "$tag" -R "$GITHUB_REPOSITORY" --json tagName,isDraft,isPrerelease,assets)"
if [ "$(jq -r '.isDraft' <<<"$release")" != false ]; then
  echo "::error::$tag is a draft, not a published release. Nothing was mirrored."
  exit 1
elif [ "$(jq -r '.isPrerelease' <<<"$release")" = true ] &&
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+$ ]]; then
  # A candidate or a beta, asked for by tag: its releases/<tag>/ only. latest/ is the Latest stable
  # release's, always. Its signing runs may still replace an installer, so its files are cached for
  # five minutes rather than a year.
  if [ "$mode" = latest ]; then
    echo "::error::The Latest release $tag is a prerelease. Nothing was mirrored."
    exit 1
  fi
  release_cache="$latest_cache"
  prerelease=true
elif [ "$(jq -r '.isPrerelease' <<<"$release")" != false ] ||
  [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::$tag is a prerelease, a draft or a candidate, not a stable release. Nothing was mirrored."
  exit 1
fi

names="$(jq -r '.assets[].name' <<<"$release")"
digest() {
  jq -r --arg name "$1" '.assets[] | select(.name == $name) | .digest // ""' <<<"$release" |
    sed -n 's/^sha256:\([0-9a-f]\{64\}\)$/\1/p'
}

fixed_names=()
while IFS= read -r name; do
  fixed_names+=("$name")
done < <("$root/scripts/release-download-names.sh" --all)
# The update feed marks a signed stable release. A candidate or a beta has none: it is never offered
# as an update, so only its installers are required.
required=(latest.json)
if [ "${prerelease:-false}" = true ]; then required=(); fi
missing=()
for name in ${required[@]+"${required[@]}"} "${fixed_names[@]}"; do
  if ! grep -qxF "$name" <<<"$names"; then
    missing+=("$name")
  fi
done
# A Latest release with none of them predates signed releases, as v0.2.0 does. That is not drift,
# so the scheduled run succeeds without touching AWS. Some but not all is a half-signed release or
# a removed file, and a release asked for by tag is wanted specifically, so both fail.
if [ "$mode" = latest ] && [ "${#missing[@]}" -eq "$(( ${#fixed_names[@]} + 1 ))" ]; then
  echo "::notice::Latest release $tag has no signed installers yet; nothing to sync."
  exit 0
fi
if [ "${#missing[@]}" -gt 0 ]; then
  echo "::error::$tag does not have the signed ${missing[*]} yet, so nothing was mirrored. The signing runs attach them before the release becomes Latest."
  exit 1
fi

# The plan: one line per object, "<key> <asset> <sha256> <cache> <type>", tab-separated, in the order
# they are uploaded. latest.json goes last, after the installers it describes.
plan="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/downloads-plan.XXXXXX")"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/downloads-sync.XXXXXX")"
mkdir "$work/assets"
# The files this run puts under releases/<tag>/, by name, for the feed's URLs.
mirrored=()
add() {
  local key="$1" asset="$2" cache="$3" sha="${4:-}" type
  if [ -z "$sha" ]; then sha="$(digest "$asset")"; fi
  if [[ "$key" == "releases/$tag/"* ]]; then mirrored+=("$asset"); fi
  if [ -z "$sha" ]; then
    echo "::error::GitHub reports no SHA-256 digest for $asset on $tag, so it cannot be checked. Nothing was mirrored."
    exit 1
  fi
  case "$asset" in
    *.dmg) type=application/x-apple-diskimage ;;
    *.exe) type=application/vnd.microsoft.portable-executable ;;
    *.json) type=application/json ;;
    *) type=application/octet-stream ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\n' "$prefix$key" "$asset" "$sha" "$cache" "$type" >> "$plan"
}

for fixed in "${fixed_names[@]}"; do
  versioned=()
  while IFS= read -r name; do
    # Only installers have a fixed name; every other asset fails the lookup and is not mirrored.
    if [[ "$name" == OpenBot_* ]] &&
      [ "$("$root/scripts/release-download-names.sh" "$name" 2> /dev/null || true)" = "$fixed" ]; then
      versioned+=("$name")
    fi
  done <<<"$names"
  if [ "${#versioned[@]}" -ne 1 ]; then
    echo "::error::$tag should have one installer published as $fixed, and has ${#versioned[@]}. Nothing was mirrored."
    exit 1
  fi
  if [ "$(digest "${versioned[0]}")" != "$(digest "$fixed")" ]; then
    echo "::error::${versioned[0]} on $tag is not the signed build attached as $fixed. Nothing was mirrored."
    exit 1
  fi
  add "releases/$tag/${versioned[0]}" "${versioned[0]}" "$release_cache"
done
# The rest of what the app downloads from the release: the image list a deployment pins
# (desktop/src-tauri/src/deployment.rs), the list of every image the app may pull for it, which an
# older app reads to get the release's images ready before its Update click
# (desktop/src-tauri/src/update_ready.rs), and the Mac updater's archives, which latest.json names.
for asset in container-images.json desktop-images.json OpenBot-darwin-aarch64.app.tar.gz OpenBot-darwin-x86_64.app.tar.gz; do
  if grep -qxF "$asset" <<<"$names"; then
    add "releases/$tag/$asset" "$asset" "$release_cache"
  fi
done
feed_urls=()
if [ "$mode" = latest ]; then
  for fixed in "${fixed_names[@]}"; do
    add "latest/$fixed" "$fixed" "$latest_cache"
  done
  # The feed the app updates from, with each platform's download moved to this address: a URL that
  # is exactly this release's GitHub download of a file this run puts under releases/<tag>/ becomes
  # that file's address here. Nothing else changes, by a byte: minisign signs each file, not its
  # URL, so every signature stays as the signing run wrote it. The release's own latest.json is
  # left as it is. It is compared and uploaded by the SHA-256 of what this run wrote, and last.
  feed="$work/assets/latest.json"
  gh release download "$tag" -R "$GITHUB_REPOSITORY" --pattern latest.json --dir "$work/assets"
  if [ "$(openssl dgst -sha256 -binary "$feed" | od -An -v -tx1 | tr -d ' \n')" != "$(digest latest.json)" ]; then
    echo "::error::latest.json downloaded from $tag does not match the digest GitHub reports for it. Nothing was mirrored."
    exit 1
  fi
  cp "$feed" "$work/latest.github.json"
  # Read whole, trailing newlines included, and changed only by replacing whole JSON strings.
  text="$(cat "$feed"; printf x)"
  text="${text%x}"
  github="https://github.com/$GITHUB_REPOSITORY/releases/download/$tag/"
  while IFS= read -r url; do
    file="${url#"$github"}"
    if [ "$file" = "$url" ] || [ -z "$file" ] || [[ "$file" == */* ]]; then continue; fi
    for name in "${mirrored[@]}"; do
      if [ "$name" = "$file" ]; then
        moved="$downloads_url/${prefix}releases/$tag/$file"
        # Quoted pattern, unquoted replacement, and patsub_replacement off (above): the one form
        # that replaces literally in both macOS's bash 3.2 and bash 5.2+, where a quoted
        # replacement keeps its quotes and an unquoted & stands for the match.
        from="\"$url\""
        to="\"$moved\""
        text="${text//"$from"/$to}"
        feed_urls+=("$moved")
        break
      fi
    done
  done < <(jq -r '.platforms // {} | .[] | .url // empty' "$feed")
  printf '%s' "$text" > "$feed"
  # Every rewritten URL is in the feed, and every other field reads as it did.
  for moved in ${feed_urls[@]+"${feed_urls[@]}"}; do
    if ! jq -e --arg url "$moved" '[.platforms[].url] | index($url)' "$feed" > /dev/null; then
      echo "::error::latest.json on $tag names its downloads in a form this cannot rewrite. Nothing was mirrored."
      exit 1
    fi
  done
  if [ "$(jq -S 'del(.platforms[]?.url)' "$feed")" != "$(jq -S 'del(.platforms[]?.url)' "$work/latest.github.json")" ]; then
    echo "::error::Rewriting latest.json on $tag would change more than its URLs. Nothing was mirrored."
    exit 1
  fi
  add latest/latest.json latest.json "$latest_cache" \
    "$(openssl dgst -sha256 -binary "$feed" | od -An -v -tx1 | tr -d ' \n')"
fi

# What S3 holds now. S3 computed ChecksumSHA256 itself when the object was uploaded with one, so an
# object put there any other way reads as different and is replaced.
uploads=()
while IFS=$'\t' read -r key asset sha cache type; do
  if head="$(aws s3api head-object --bucket "$bucket" --key "$key" --checksum-mode ENABLED \
    --output json 2> "$work/head-error")"; then
    held="$(jq -r '.ChecksumSHA256 // ""' <<<"$head" | openssl base64 -d -A | od -An -v -tx1 | tr -d ' \n')"
    if [ "$held" = "$sha" ] &&
      [ "$(jq -r '.CacheControl // ""' <<<"$head")" = "$cache" ] &&
      [ "$(jq -r '.ContentType // ""' <<<"$head")" = "$type" ]; then
      echo "s3://$bucket/$key is already $asset."
      continue
    fi
  elif ! grep -q '(404)' "$work/head-error"; then
    echo "::error::Could not read s3://$bucket/$key: $(cat "$work/head-error")"
    exit 1
  fi
  uploads+=("$key")
done < "$plan"

if [ "${#uploads[@]}" -eq 0 ]; then
  echo "downloads.copilotkit.ai already serves $tag. Nothing to upload."
  exit 0
fi

# Every file is downloaded and checked against GitHub's digest before the first upload, so a bad
# download changes nothing. latest.json is the rewritten feed, checked against what this run wrote.
for key in "${uploads[@]}"; do
  asset="$(awk -F '\t' -v key="$key" '$1 == key { print $2 }' "$plan")"
  sha="$(awk -F '\t' -v key="$key" '$1 == key { print $3 }' "$plan")"
  if [ ! -f "$work/assets/$asset" ]; then
    gh release download "$tag" -R "$GITHUB_REPOSITORY" --pattern "$asset" --dir "$work/assets"
  fi
  got="$(openssl dgst -sha256 -binary "$work/assets/$asset" | od -An -v -tx1 | tr -d ' \n')"
  if [ "$got" != "$sha" ]; then
    echo "::error::$asset downloaded from $tag does not match the digest GitHub reports for it. Nothing was uploaded."
    exit 1
  fi
done

# Each download the feed names here must answer through the address before the feed goes up, so
# it never names a file that is not there. A miss is asked again, twice, after DOWNLOADS_VERIFY_DELAY
# seconds (default 10), which outlasts CloudFront's caching of a 403 from before the upload.
check_feed() {
  local url code attempt
  for url in ${feed_urls[@]+"${feed_urls[@]}"}; do
    for attempt in 1 2 3; do
      code="$(curl --silent --head --output /dev/null --write-out '%{http_code}' "$url" || true)"
      if [ "$code" = 200 ]; then break; fi
      if [ "$attempt" = 3 ]; then
        echo "::error::$url answers $code, so latest.json, which names it, was not uploaded."
        exit 1
      fi
      sleep "${DOWNLOADS_VERIFY_DELAY:-10}"
    done
  done
}

changed_latest=false
for key in "${uploads[@]}"; do
  IFS=$'\t' read -r _ asset _ cache type < <(awk -F '\t' -v key="$key" '$1 == key' "$plan")
  if [ "$key" = "${prefix}latest/latest.json" ]; then
    check_feed
  fi
  # S3 refuses the upload unless the bytes it received hash to this checksum.
  aws s3api put-object --bucket "$bucket" --key "$key" --body "$work/assets/$asset" \
    --content-type "$type" --cache-control "$cache" \
    --checksum-sha256 "$(openssl dgst -sha256 -binary "$work/assets/$asset" | openssl base64 -A)" \
    --output json > /dev/null
  echo "Uploaded $asset to s3://$bucket/$key."
  if [[ "$key" == "${prefix}latest/"* ]]; then
    changed_latest=true
  fi
done

if [ "$changed_latest" = true ]; then
  invalidation="$(aws cloudfront create-invalidation --distribution-id "$DOWNLOADS_DISTRIBUTION_ID" \
    --paths "/${prefix}latest/*" --output json)"
  echo "Invalidated /${prefix}latest/* ($(jq -r .Invalidation.Id <<<"$invalidation"))."
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### downloads.copilotkit.ai now serves $tag"
    echo ""
    for key in "${uploads[@]}"; do
      echo "- uploaded \`$key\`"
    done
  } >> "$GITHUB_STEP_SUMMARY"
fi

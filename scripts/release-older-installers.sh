#!/usr/bin/env bash
# Removes the installers of every release older than the Latest one, from the GitHub releases and
# from the bucket behind downloads.copilotkit.ai, so a fresh install starts from the Latest release
# or a newer one and never from an older installer.
#
# Why: a fresh install lays out the Latest release's server stack whatever installer started it,
# and an app older than that stack may not set it up the way it needs. An app from 1.0.3 or before
# writes no install token, which the 1.1 server requires, so it crash-loops.
#
# Usage:
#   release-older-installers.sh select <latest tag>  the rule, and nothing else. Reads a release list on
#                                                    stdin, a JSON array of {"tag": "v1.0.3", "assets":
#                                                    ["<file name>", ...]}, and prints "<tag><TAB><file>"
#                                                    for each installer to remove
#   release-older-installers.sh github [--dry-run]   removes them from the GitHub releases
#   release-older-installers.sh bucket [--dry-run]   removes them from releases/<tag>/ in the bucket, and
#                                                    invalidates each removed path
#
# The rule. A release is older when its tag is a version (vX.Y.Z or vX.Y.Z-<pre>) that sorts below
# the Latest one by semver: a lower X.Y.Z, or a candidate or beta of the Latest version itself. On an
# older release it removes each installer, under its versioned name or its fixed name
# (scripts/release-download-names.sh): every .dmg, .exe (-setup.exe included), .msi, .AppImage, .deb
# and .rpm, and each one's .sig. Everything else stays: latest.json, the updater archives
# (.app.tar.gz) and their .sig, container-images.json, desktop-images.json, the source archives, the
# release manifest and provenance. An installed app reads its updates from the Latest release's feed
# and repairs from its own release's container-images.json and source, so those must stay. The
# Latest release, anything newer (a next candidate), and any tag that is not a version are untouched.
#
# `github` and `bucket` read the Latest release from GitHub, never from an argument, so a mistyped
# tag can never remove the installers the website links to. With no Latest release, nothing is
# older. Running either again changes nothing.
#
# Run by scripts/release-make-latest.sh (github) right after it makes a release Latest, and by
# Downloads sync (bucket) on every run for the Latest release; github by hand for the
# finish-at-100% path of a staged rollout (docs/releasing.md, "Older installers").
#
# Env:
#   GITHUB_REPOSITORY and GH_TOKEN  for `gh`
#   DOWNLOADS_BUCKET                bucket: the bucket behind the distribution
#   DOWNLOADS_DISTRIBUTION_ID       bucket: the CloudFront distribution
#   DOWNLOADS_PREFIX                bucket: as in scripts/downloads-sync.sh, a scratch folder such as
#                                   `smoketest/` that every key is under
#   and for bucket, AWS credentials that may list the bucket, delete its objects (s3:DeleteObject) and
#   invalidate the distribution. The bucket is versioned, so a delete only adds a delete marker and
#   each removed installer can be restored from its earlier version.
set -euo pipefail

usage() {
  echo "usage: release-older-installers.sh select <latest tag> | github [--dry-run] | bucket [--dry-run]" >&2
  exit 2
}

# The rule: a release list on stdin, the Latest tag in $1, and "<tag><TAB><file>" out for each
# installer to remove, in the order the list gives them.
select_installers() {
  local latest="$1"
  if [[ ! "$latest" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    echo "::error::The Latest release '$latest' is not a stable version such as v1.1.0, so nothing is older than it. Nothing was selected." >&2
    return 1
  fi
  jq -r --arg latest "$latest" '
    def version:
      [capture("^v(?<major>0|[1-9][0-9]*)\\.(?<minor>0|[1-9][0-9]*)\\.(?<patch>0|[1-9][0-9]*)(-(?<pre>[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*))?$")]
      | if length == 0 then null
        else first | {core: [(.major, .minor, .patch) | tonumber], pre: .pre}
        end;
    ($latest | version) as $l
    | .[]
    | (.tag | version) as $v
    | select($v != null and ($v.core < $l.core or ($v.core == $l.core and $v.pre != null)))
    | .tag as $tag
    | .assets[]
    | select(test("\\.(dmg|exe|msi|AppImage|deb|rpm)(\\.sig)?$"))
    | "\($tag)\t\(.)"
  '
}

# The tag GitHub calls Latest, or nothing when no release is. Only a 404 means none: any other
# failure stops here, as reading it as "none" would leave old installers up without saying so.
latest_tag() {
  local out
  if out="$(gh api "repos/$GITHUB_REPOSITORY/releases/latest" --jq .tag_name 2>&1)"; then
    printf '%s\n' "$out"
  elif grep -q 'HTTP 404' <<<"$out"; then
    printf '\n'
  else
    echo "::error::Could not read the Latest release, so nothing was removed: $out" >&2
    return 1
  fi
}

mode="${1:-}"
case "$mode" in
  select)
    [ "$#" -eq 2 ] || usage
    select_installers "$2"
    exit 0
    ;;
  github | bucket) ;;
  *) usage ;;
esac
dry_run=false
case "${2:-}" in
  "") ;;
  --dry-run) dry_run=true ;;
  *) usage ;;
esac

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must name the repository}"
# Assigned first: a failure inside a command's argument would not stop the script.
latest="$(latest_tag)"
if [ -z "$latest" ]; then
  echo "There is no Latest release, so no release is older than it. Nothing to remove."
  exit 0
fi

if [ "$mode" = github ]; then
  releases="$(gh api --paginate "repos/$GITHUB_REPOSITORY/releases?per_page=100" \
    --jq '.[] | {tag: .tag_name, assets: [.assets[].name]}')"
  selected="$(jq -s . <<<"$releases" | select_installers "$latest")"
  count=0
  while IFS=$'\t' read -r tag name; do
    [ -n "$tag" ] || continue
    count=$((count + 1))
    if [ "$dry_run" = true ]; then
      echo "Would remove $name from $tag."
    else
      gh release delete-asset "$tag" "$name" -R "$GITHUB_REPOSITORY" --yes
      echo "Removed $name from $tag."
    fi
  done <<<"$selected"
  if [ "$count" -eq 0 ]; then
    echo "Nothing to remove: no release older than $latest has an installer."
  elif [ "$dry_run" = true ]; then
    echo "$count installers on releases older than $latest would be removed. This was a dry run: nothing was removed."
  else
    echo "Removed $count installers from releases older than $latest."
  fi
  exit 0
fi

# The bucket: each releases/<tag>/<file> it holds, read as a release list and put through the same
# rule.
: "${DOWNLOADS_BUCKET:?DOWNLOADS_BUCKET must name the bucket}"
: "${DOWNLOADS_DISTRIBUTION_ID:?DOWNLOADS_DISTRIBUTION_ID must name the CloudFront distribution}"
bucket="$DOWNLOADS_BUCKET"
prefix="${DOWNLOADS_PREFIX:-}"
if [ -n "$prefix" ] && [[ ! "$prefix" =~ ^[a-z0-9][a-z0-9-]*/$ ]]; then
  echo "::error::DOWNLOADS_PREFIX must be a single lowercase folder ending in /, such as smoketest/."
  exit 1
fi
listing="$(aws s3api list-objects-v2 --bucket "$bucket" --prefix "${prefix}releases/" --output json)"
if [ -z "$listing" ]; then listing='{}'; fi
selected="$(jq --arg under "${prefix}releases/" '
  [(.Contents // [])[].Key | ltrimstr($under) | select(test("^[^/]+/[^/]+$")) | split("/")
    | {tag: .[0], name: .[1]}]
  | group_by(.tag) | map({tag: .[0].tag, assets: map(.name)})
' <<<"$listing" | select_installers "$latest")"

removed=()
failed=0
while IFS=$'\t' read -r tag name; do
  [ -n "$tag" ] || continue
  key="${prefix}releases/$tag/$name"
  if [ "$dry_run" = true ]; then
    echo "Would remove s3://$bucket/$key."
    removed+=("$key")
  elif aws s3api delete-object --bucket "$bucket" --key "$key" --output json > /dev/null; then
    echo "Removed s3://$bucket/$key."
    removed+=("$key")
  else
    # Every other removal is still tried, and what was removed is still invalidated, below.
    echo "::error::Could not remove s3://$bucket/$key. Its credentials need s3:DeleteObject on the bucket."
    failed=$((failed + 1))
  fi
done <<<"$selected"

if [ "${#removed[@]}" -eq 0 ] && [ "$failed" -eq 0 ]; then
  echo "Nothing to remove: no release older than $latest has an installer in s3://$bucket/${prefix}releases/."
  exit 0
fi
if [ "$dry_run" = true ]; then
  echo "${#removed[@]} installers on releases older than $latest would be removed from s3://$bucket/${prefix}releases/, and their paths invalidated. This was a dry run: nothing was removed."
  exit 0
fi
# Each removed installer was cached for a year, so each path is invalidated, or CloudFront would go
# on serving it.
if [ "${#removed[@]}" -gt 0 ]; then
  paths=()
  for key in "${removed[@]}"; do paths+=("/$key"); done
  invalidation="$(aws cloudfront create-invalidation --distribution-id "$DOWNLOADS_DISTRIBUTION_ID" \
    --paths "${paths[@]}" --output json)"
  echo "Removed ${#removed[@]} installers from releases older than $latest, and invalidated their paths ($(jq -r .Invalidation.Id <<<"$invalidation"))."
fi
if [ "$failed" -gt 0 ]; then
  echo "::error::$failed installers on releases older than $latest could not be removed from s3://$bucket/."
  exit 1
fi

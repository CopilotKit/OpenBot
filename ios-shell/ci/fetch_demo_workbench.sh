#!/bin/bash
# Fetch the workbench from this run while Xcode prepares the simulator test.
set -euo pipefail

destination="$RUNNER_TEMP/ios-demo-workbench"
archive="$RUNNER_TEMP/ios-demo-workbench.zip"
trap 'if [[ $? != 0 ]]; then touch "$RUNNER_TEMP/fixture.failed"; fi' EXIT
name="ios-demo-workbench-$GITHUB_RUN_ATTEMPT"
artifacts="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts?per_page=100"
for ((attempt=0; attempt<60; attempt++)); do
  if data=$(gh api "$artifacts"); then
    entry=$(jq -r --arg name "$name" '.artifacts[] | select(.name == $name and (.expired | not)) | [.id, .digest] | @tsv' <<<"$data")
    if [[ -n "$entry" ]]; then
      IFS=$'\t' read -r id digest <<<"$entry"
      if [[ ! "$id" =~ ^[0-9]+$ || ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
        echo "The workbench artifact has no usable identifier or SHA-256 digest." >&2
        exit 1
      fi
      if gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$id/zip" >"$archive"; then
        echo "${digest#sha256:}  $archive" | shasum -a 256 -c -
        mkdir -p "$destination"
        unzip -qo "$archive" -d "$destination"
        touch "$RUNNER_TEMP/fixture.ready"
        exit 0
      fi
    fi
  fi
  sleep 5
done
echo "The workbench artifact did not become available." >&2
exit 1

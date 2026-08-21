# Releasing

A release is one person choosing a version, and a reviewed pull request doing everything else. No
step involves a terminal, a tag pushed by hand, or an image built on somebody's laptop.

## Cutting one

1. Check `## Unreleased` in [CHANGELOG.md](../CHANGELOG.md) reads the way you want it to. It is the
   release notes. Nothing is generated from commit subjects, because a commit subject is written for
   the person reading the diff and these notes are for the person deciding whether to upgrade.
2. Run **Create release PR** from the Actions tab, choosing `patch`, `minor` or `major`. Use
   `dry_run` first if you want to see the version and the notes without opening anything.
3. Review the pull request it opens. It contains exactly two changes: the version in `package.json`
   and the `## Unreleased` heading becoming `## X.Y.Z`.
4. Merge it. That is the publish.

Merging is the trigger, so a release is always a reviewed commit on `main`.

## What merging does

`publish-release.yml` runs on every push to `main` and starts by deciding whether the commit is a
release at all. It asks the API for the pull request that produced the commit, and requires that the
head branch matches `release/publish/vX.Y.Z`, that the branch is in this repository, and that the
pull request carries the `release` label. A fork can name a branch anything; it cannot add a label.

Then, in order:

- the version in the tree is checked against the branch that is publishing it, and the changelog is
  checked for a section with that number
- one image is built and pushed to `ghcr.io/copilotkit/openbot`, tagged with the version, the commit
  and `latest`
- a build provenance attestation is signed with the workflow's OIDC identity and pushed alongside it
- the commit is tagged and a GitHub Release is created, carrying the changelog section as its notes
  and `container-images.json` as an asset

## Deploying a release

`container-images.json` pins the digest. Deploy that, not a tag:

```sh
gh release download v0.1.0 --pattern container-images.json
docker run -p 3001:3001 --env-file .env \
  "$(jq -r .images.openbot.reference container-images.json)"
```

A tag can be moved to point at a different image; a digest cannot. The same digest that CI smoke
tested is the one that runs, and rolling back is the same command with an earlier version.

Before deploying, you can check the image is the one this repository built:

```sh
gh attestation verify oci://ghcr.io/copilotkit/openbot:v0.1.0 -R CopilotKit/OpenBot
```

## What has to be green

Branch protection should require one check, `verify`, which fails unless every other job succeeded.
A job added to `ci.yml` is covered by it without anybody updating a list.

| check | what it would catch |
| --- | --- |
| `format, lint, types` | the ordinary things |
| `tests` | a decision made wrongly, in isolation |
| `build` | the app not compiling |
| `migrations` | a schema change with no migration, or a snapshot that has drifted |
| `image` | an image that builds but does not boot, or a supervised service that respawns |

`image` matters more than its position suggests. Everything above it can pass on a tree whose image
never starts, because nothing else here runs the thing it ships. It builds the container, boots it
with embedded PostgreSQL, waits for `/api/capabilities`, and fails if a supervised service is
respawning.

These checks run again, against the release commit, when the release PR is merged. They gate the
publish rather than the proposal, which is why the release PR arriving without its own checks does
not matter: a pull request opened by a workflow does not trigger them.

**No secrets are required.** Every workflow here uses only the built-in `GITHUB_TOKEN`.

## The one thing CI cannot do

The smoke journey in `tests/smoke` is the only check that proves the parts are wired to each other:
the server reaches the supervisor, the supervisor builds a computer, the gateway decides before the
browser acts, and the trail records it. It cannot run in CI, and this is not a gap to be closed
later.

OpenBot only runs in Intelligence mode. `loadConfig` refuses to start without a licence, and a
licence is cryptographically signed for the machine it was issued for, so a hosted runner cannot hold
one. The `image` check gets around this with placeholder values, because nothing is contacted at
start-up, but the journey asserts `licenseStatus` is `valid` and no placeholder can make that true.

So it is a step a person takes, on a machine with a licence, before merging the release PR:

```sh
bash scripts/start.sh
bun run test:smoke
```

The release PR asks for the result in a comment. That is deliberately a person rather than a robot:
it is the one gate that cannot be automated, so it is the one gate worth naming.

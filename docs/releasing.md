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
| `smoke` | the parts not wired to each other: server, supervisor, computer, gateway, audit |

The last two matter more than their position in that list suggests. Everything above them can pass
on a tree whose image never starts, because nothing else here runs the thing it ships.

## Secrets it needs

| | |
| --- | --- |
| `DEVOPS_BOT_CLIENT_ID` (variable), `DEVOPS_BOT_PRIVATE_KEY` | opening the release PR as an app rather than with a personal token |
| `COPILOTKIT_LICENSE_TOKEN`, `INTELLIGENCE_API_KEY`, `OPENAI_API_KEY` | the smoke journey, which needs a deployment a licence accepts |

The smoke job skips itself, with a warning, when the licence is absent. That is deliberate: a check
that fails for a reason nobody can fix is a check people learn to ignore.

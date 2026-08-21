# Changelog

What changed, for somebody deciding whether to upgrade. Written for the person running OpenBot, not
for the person who wrote the commit: a line belongs here when a deployment behaves differently
afterwards, and does not when only the code moved.

Newest first. `Unreleased` is what is on `main` and not yet tagged.

## Unreleased

### Added

- **Releases are cut by a workflow, not by hand.** `Create release PR` bumps the version and promotes
  `## Unreleased` to a numbered section; merging the pull request it opens is what publishes. Merging
  builds and pushes one image to `ghcr.io/copilotkit/openbot`, signs a build provenance attestation
  for its digest, tags the commit and creates the GitHub Release with `container-images.json` so a
  deployment can name an exact digest rather than a tag somebody could move. See
  [docs/releasing.md](docs/releasing.md).
- **CI now runs the thing it ships.** Two checks were added. `migrations` refuses a schema change
  with no migration written for it, and a snapshot that has drifted from the schema. `image` builds
  the container, boots it with embedded PostgreSQL, and fails if it does not answer or if a
  supervised service is respawning. A single `verify` check covers every job, so branch protection
  needs one entry. The same checks run again against the release commit when a release is published,
  so they gate the release rather than the proposal for one.
- **One container that runs the whole thing.** The root `Dockerfile` builds an image carrying the
  app, the API, a Bot computer, and optionally PostgreSQL, supervised together. Point `DATABASE_URL`
  at a database you already run and the built-in one never starts; leave it unset and the container
  is self-contained. See [docs/deployment.md](docs/deployment.md) for the measured minimum sizes and
  the platforms it has been run on.
- **Bots can run commands.** `computer_run_command` runs a command in the Bot's `/workspace`, so a
  Bot can install a tool, unpack what it downloaded, or run what it was asked to run instead of only
  driving a browser. Governed like every other action: the policy decides, the audit row is written
  first, and a rule can refuse a shell outright with `intent == "run_command"` or refuse particular
  commands. The command is recorded; its output is not.
- **The audit trail shows the command.** A command row names what ran, the way a file row names the
  path, rather than reporting an element it was never about.
- **`COMPUTER_SANDBOX=on`** turns on Chromium's own sandbox where the host permits user namespaces.
  Which way it went is printed at start-up either way.

### Fixed

- **A Bot's shell was handed the deployment's secrets.** A command ran with the whole environment of
  the process that started it, and in the one-container image that environment carries
  `COMPUTER_TOKEN`, `DATABASE_URL`, `KEY_ENCRYPTION_KEY`, the licence and the model key. The token is
  the only thing in front of the computer's control surface, and the shell runs inside the process
  that serves it, so a command could drive the browser over loopback with no policy decision and no
  audit row: the gateway was optional for the one actor it exists to constrain. The database URL and
  the encryption key together opened the credential vault and the trail meant to record what
  happened. A command now receives `HOME`, `PATH`, `DEBIAN_FRONTEND` and the locale, and nothing
  else. `apt-get` also stops waiting for a prompt nobody can answer.


- **A deployment served over plain HTTP could not start a conversation.** The chat surface minted
  identifiers with `crypto.randomUUID`, which browsers withhold outside a secure context. On a
  laptop `http://localhost` counts as one, so this never showed up in development; on a real
  address it does not, and the surface did nothing at all when you pressed send. No message, no
  error. Ids now come from an API with no such restriction.

### Changed

- **Where a Bot's computer runs is now a plug.** One `ComputerProvider` interface sits under the
  gateway, with the Docker supervisor as one implementation and a shared computer as another. A
  computer somewhere else is an adapter rather than a change to the governed path. Thanks to
  [@mu-hashmi](https://github.com/CopilotKit/OpenBot/pull/57) for the refactor.
- The address a provider hands back is checked before anything is sent to it, and the cloud metadata
  addresses are refused whatever a provider says.
- The container image runs as an unprivileged user rather than root.

## 0.0.1

First tag.

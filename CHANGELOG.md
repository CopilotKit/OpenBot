# Changelog

What changed, for somebody deciding whether to upgrade. Written for the person running OpenBot, not
for the person who wrote the commit: a line belongs here when a deployment behaves differently
afterwards, and does not when only the code moved.

Newest first. `Unreleased` is what is on `main` and not yet tagged.

## Unreleased

### Upgrading

Two configurations now refuse to start:

- A provider configured with no `INITIAL_ADMIN_EMAILS`. Set it to at least one address.
- No provider at all and no `OPENBOT_SINGLE_USER=true`. Configure a provider, or set that to say you
  meant a deployment where every visitor is one administrator. This no longer depends on `NODE_ENV`,
  which is unset by default and so let exactly the dangerous case through. A deployment already
  running open needs the line added before it will start again.

Registering an OpenID Connect provider needs every host in its discovery document in
`TRUSTED_ORIGINS`, not only the issuer. Better Auth 1.7 checks each endpoint it finds, so a Google
issuer also needs `oauth2.googleapis.com` and `openidconnect.googleapis.com`. Registration is
refused with the untrusted host named.

A Bot id may now contain only letters, digits, hyphen and underscore, and must start with a letter or
digit. The same rule container and volume names have always followed. A deployment whose
`COMPUTER_BOT_ID` breaks it refuses to start and says so, rather than answering 400 to everything.

`AUDIT_RETENTION_DAYS` is new and unset, which keeps the audit trail forever, as before. Set it to a
whole number of days to have old rows removed.

`MANAGED_AGENT_AG_UI_URL` is no longer required to start. The one-container image does not carry a
Bot, so requiring it registered the shipped Risk Analyst against a host that was not there and every
conversation with it failed. Leave it unset for that image. A laptop `scripts/start.sh` still points
it at `agent-langgraph`. A URL with no `MANAGED_AGENT_TOKEN` still refuses to start; a leftover
token with no URL is ignored.

A `.env` copied from an older `.env.example` still has `MANAGED_AGENT_AG_UI_URL=http://localhost:4201/ag-ui`.
Unset it before `docker run --env-file .env`, or the coworker comes back.

Sessions survive and nobody signs in again.

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
- **Sign in with Google, Microsoft or Okta.** Any one of them turns sign-in on; configure several
  and the sign-in screen offers each, on matching buttons carrying each provider's own mark.
  `INITIAL_ADMIN_EMAILS` says who is an administrator. It is required whenever a provider is
  configured, because nothing else grants the role, and it is now a floor rather than a one-off:
  an address it names is made an administrator at every sign-in, so adding somebody to the list
  works even after they have already signed in.
- **SAML and OpenID Connect, registered while running.** `/admin/identity-providers` takes the
  metadata a company's identity team supplies and registers their own IdP. Somebody then types their
  email address on the sign-in screen and the domain decides which provider they are sent to, so a
  company mid-merger can run two. Registering, changing or removing one is administrator-only, which
  the upstream plugin does not require: it guards those routes with a session, and anybody who could
  reach them could register a provider for a domain and mint themselves colleagues.
- **A People screen.** `/admin/people` lists everybody who has signed in, with the provider they came
  through and when they were last here, and lets an administrator promote, demote, or remove
  somebody. Removing ends the session they are using and stops the next sign-in, keyed on the
  address so signing in again through the provider does not quietly create a new account. Every
  change is on the audit trail. Somebody named in `INITIAL_ADMIN_EMAILS` cannot be demoted or
  removed here, and nobody can do either to themselves.
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
- **You can watch what a Bot is doing, not only what it is looking at.** The screen answered half the
  question: a Bot spending two minutes in a terminal showed a blank browser and one grey line per
  command, with the output nowhere. A command line in the transcript now opens to show what it
  printed, its exit code, and whether it was cut short or stopped. Beside the screen there is an
  Activity tab carrying every command, file read, file write and listing as they happen, newest
  first, with a count on the tab so a Bot working away from the browser is visible without switching
  to it. A saved file shows its path and size, never its contents. This is a live view of the open
  conversation; the record is still the audit trail.
- **Sign-in is on the audit trail.** Rows for signing in, for being refused, and for the configured
  administrator list granting somebody the role. Two questions had no answer before: who granted
  themselves administrator by editing `INITIAL_ADMIN_EMAILS`, and whether somebody just removed had
  ever been here, since removing them deletes the sessions that were the only evidence. A trail that
  is unavailable never blocks a sign-in.

### Fixed
- **The one-container image registered a coworker it could not run.** `MANAGED_AGENT_AG_UI_URL`
  defaulted to `localhost:4201` and was required, so Risk Analyst appeared on the roster and every
  conversation with it failed. The URL is optional; the package omits that coworker when it is
  unset. `scripts/start.sh` still points it at `agent-langgraph` on a laptop.
- **A boundary rule applied on one server out of N.** The policy is read from memory on every action,
  which is right, but memory was only ever filled at boot. An administrator's new deny rule was
  enforced by whichever process served the request and roughly one action in N went through it, while
  the admin screen reported success because the row really was saved and the audit trail agreed
  because it records the boundary each process started with. Both honest, and both describing
  something other than what the fleet was enforcing. A write now announces on Postgres in the same
  transaction and every server re-reads, including on reconnect, so a server that was down when the
  rule changed catches up rather than waiting for a restart. Reset travels the same way.
- **A ref resolved on one replica and nowhere else.** The gateway turns the opaque ref in a click into
  the element it points at, and that mapping lived in a `Map` in the process that took the snapshot.
  On any other replica the ref resolved to nothing, so a deny rule written about the element did not
  match and the click went through, recorded as allowed with no rule. It is in Postgres now, keyed on
  the generation the computer stamped, so a ref from a superseded page still resolves to nothing.
- **Anybody signed in could act as anybody's Bot.** The Bot id travels in the path and the acting
  routes checked only that somebody was signed in, so a signed-in person could drive another person's
  private Bot, reset its browser, read its screen and fire its granted tools. Every route under a Bot
  id now asks the store the same question the roster already asks, and a Bot that does not exist and
  one belonging to somebody else answer identically.
- **The computer fleet listing was open to any signed-in person.** It ignores its `:botId` and returns
  every Bot's machine, so it told anybody who could reach it every Bot id in the deployment and
  whether each was running, private coworkers included. Administrator-only now.
- **A Bot id could name a directory outside the profiles volume.** The id arrives as a URL segment or
  a header, was joined onto a filesystem path, and `reset` deletes that path recursively as root, so
  `../../tmp/something` deleted it. Refused at the request boundary and again where the path is built.
- **A mistyped deny rule permitted instead of refusing.** A rule that parsed and evaluated but
  answered with something other than true or false was neither a match nor an error, so
  `deny: ["Submit order"]` — what somebody writes who reads the list as labels — let the action
  through with nothing logged, while the rule sat on the Boundaries page looking as though it were in
  force. Any non-boolean answer is now a broken rule and takes the existing fail-closed path.
- **Rotating a Bot's key left the old one live.** Editing a key wrote a new vault row and repointed
  the Bot at it, leaving the previous credential decryptable and still valid with nothing listing it,
  so rotation did not do the one thing rotation is for. Deleting a Bot left its key live too. Both
  revoke now.
- **Nothing recorded what changed about a Bot.** Ten mutating routes wrote one audit row between them
  and there was no event type for any of the other nine. A Bot's endpoint is where conversation
  content is sent, so "who pointed this Bot at that host, and when" is the first question in an
  incident and could not be answered. Eight event types and eight rows now, recording what changed and
  never a value.
- **The people list and the channel list grew without bound.** Both were read in full on every render,
  and reading one person ran the whole people aggregate over the deployment twice per role change.
  Both are paged now, and the people screen searches on the server so somebody can be found without
  walking pages.
- **A computer accumulated one browser per Bot, forever.** `COMPUTER_MAX_BROWSERS` and
  `COMPUTER_BROWSER_IDLE_MS` set the two limits. Nothing closed an idle one, so a deployment
  where every employee has a Bot trends toward a resident Chromium per employee in one container until
  it is killed for memory. There is a cap and an idle timeout, and closing one costs only a relaunch
  because the profile is on disk.
- **The audit screen's filters were sequential scans.** It filters by event type, by who did it and by
  what it was done to, and the only index was on the timestamp, over what becomes the largest table in
  the deployment. Each filter leads its own index now.
- **A deployment with no identity provider came up open by default.** Covered under Changed above,
  and listed here too because it is the one on this list that was reachable from the internet.
- **Registering a company's identity provider was owned by whoever registered it.** Better Auth
  answers its own listing route with only the providers the person asking registered, and refuses a
  removal from anybody else, so a second administrator opened the Identity providers screen, found
  it empty, and registered one that already existed. Worse, the row cascaded from that person's user
  row: deleting the administrator who set sign-in up deleted the company's sign-in with them. What is
  registered is a fact about the deployment, so reads and removals go through OpenBot's own
  administrator-only routes against the whole table, and a provider outlives the person who added it.
- **A customer's client secret was in the clear.** The SSO plugin writes `oidc_config` and
  `saml_config` as plaintext JSON, with the OAuth client secret for that company's directory inside
  them: the one secret here not going through `KEY_ENCRYPTION_KEY`. Both are now encrypted at rest.
  Rows written before this still read, and are re-encrypted the next time they are written. OAuth
  access and refresh tokens use Better Auth's own encryption, keyed on `BETTER_AUTH_SECRET`.
- **A failed provider registration looked like a button that did not work.** The error was rendered
  on the page behind the dialog, which was covering it.
- **A Bot could become root inside its container.** `sudo` was granted as `NOPASSWD: ALL`, and the
  comment above it named the two conditions that made that acceptable: the container being one Bot's
  alone, and not holding a database. The image meets neither, because the supervisor is deliberately
  not in it and `EMBEDDED_POSTGRES=on` is a documented way to run it. So root read another Bot's
  workspace, the API's environment, and the audit database recording what it did. The grant now names
  the package managers, so `apt-get install` still works and `sudo cat /proc/1/environ` does not. It
  is a floor rather than a boundary: code a model wrote needs a computer per Bot with
  `COMPUTER_SUPERVISOR_URL` and a sandbox under it with `COMPUTER_RUNTIME=runsc`, both of which this
  already supports and neither of which the single-container image can reach.
- **A command could take the computer down, or outlive being stopped.** Output was accumulated in
  full and only trimmed at the end, so `cat` of a large file allocated until the process that owns
  the browser died; it is now bounded as it arrives, and still reports that it was truncated rather
  than quietly ending. A stop signalled bash alone, so `sleep 30 | cat` left its children holding the
  pipes and the call never returned; the whole process group is signalled now. A `timeoutMs` of zero
  or less killed the command before it started and called it a timeout; it has a floor as well as a
  ceiling.
- **Stop did not reach a running command.** The `/exec` route never took the person's abort, so the
  plumbing for it was dead code and a stopped run left the command finishing inside the container.
- **The live-screen socket did not check the address it was given.** Every acting path resolved
  through the gateway, which refuses a foreign or cloud-metadata address; this one asked the provider
  directly and then put `COMPUTER_TOKEN` in the query string of whatever it was told.
- **`COMPUTER_SHELL_ENV` refuses the names that run before a command.** Naming `GITHUB_TOKEN` is an
  operator deciding a Bot may use a token. Naming `BASH_ENV`, `ENV`, `LD_PRELOAD` or the shell option
  variables is handing a Bot a hook into every later command, which is unlikely to be what was meant,
  so those are refused and said out loud rather than passed. A name that is not a variable name is
  now reported too, instead of quietly disappearing.
- **A deny rule naming one field refused every action that did not have it.** `deny:
  contains(command, "rm -rf")`, the example the documentation gives, refused every click, keypress,
  navigation and file read in the deployment. Two correct behaviours combined into a wrong one: the
  policy context left out fields an action did not have, cel-js treats a missing field as an unknown
  identifier and throws, and a thrown deny counts as a match so that a mistyped deny refuses rather
  than quietly permitting. Every field is now bound, with a neutral value where the action has
  nothing to put there, so a rule about a shell answers honestly about a click instead of refusing
  it. Rules about the action they are for are unchanged. The audit row still omits what did not
  happen.
- **A command longer than 45 seconds reported failure while it carried on running.** The transport
  gave every call the same deadline, which was shorter than the shell's own 120 second default and
  600 second maximum, so `apt-get install` told the person the computer had not responded and then
  finished installing inside the container. A command now gets a deadline that outlasts the shell,
  which reports a timeout itself and says so.

- **A Bot's shell no longer inherits the deployment's environment.** Commands ran with the computer
  process's own environment, so `env` in the one-container image printed `KEY_ENCRYPTION_KEY` and
  the rest of `.env`. The shell now receives PATH, locale and terminal names, and the proxy
  variables. Userinfo is stripped from a proxy URL, so a password in `HTTP_PROXY` is not in `env`.
  Anything else is named in `COMPUTER_SHELL_ENV`.
- **A deployment served over plain HTTP could not start a conversation.** The chat surface minted
  identifiers with `crypto.randomUUID`, which browsers withhold outside a secure context. On a
  laptop `http://localhost` counts as one, so this never showed up in development; on a real
  address it does not, and the surface did nothing at all when you pressed send. No message, no
  error. Ids now come from an API with no such restriction.

### Changed

- **A retention policy for the audit trail.** `AUDIT_RETENTION_DAYS` removes rows older than the
  window it names, swept hourly by whichever server holds an advisory lock. Unset by default, because
  deleting somebody's audit trail because a default said so is the worse of the two failures. The
  trail stays append-only: the database permits a delete only when the transaction declares a
  retention window and only for rows already outside it, so removing recent rows is still impossible
  and an `UPDATE` still is under every condition.
- **`allowed_groups` is documented as a declaration, not a control.** The tenant package writes it and
  nothing reads it on any access path, and `users.groups` is written by nothing either, so both halves
  of the rule are waiting on group membership arriving from the identity provider. Channel access is
  membership alone. The columns stay, because they are the right shape for the rule they are named
  for. Thanks to [@NathanTarbert](https://github.com/CopilotKit/OpenBot/pull/92) and
  [@andreolf](https://github.com/CopilotKit/OpenBot/issues/82).
- **Running with no sign-in takes a flag and nothing else.** It used to be locked with
  `NODE_ENV=production`, which is exactly backwards: `NODE_ENV` is unset unless somebody sets it, so
  a container on a VM with a hand-written env file and no identity provider served every visitor on
  the internet as an administrator, silently, because nothing looked wrong from the outside. A
  deployment with no provider now refuses to start unless `OPENBOT_SINGLE_USER=true` says it was
  meant. `.env.example` ships that line switched on, so a clone still runs with no configuration at
  all, and the line is greppable in a way a default never was. `OPENBOT_DEV_NO_AUTH` is still
  honoured.
- **Requires Better Auth 1.7**, which adds an `issuer` to every account. Migrations `0002` and `0003`
  add the column and backfill existing rows with their provider's real issuer, so nobody is asked to
  sign in again. The column stays nullable on purpose: a rolling deploy runs migrations and then
  serves from old and new replicas at once, and an old replica writes an account without it, so
  making it required in the same release would break the first sign-in of everybody who landed on a
  replica that had not been replaced yet. The constraint belongs to a later release.
- **Where a Bot's computer runs is now a plug.** One `ComputerProvider` interface sits under the
  gateway, with the Docker supervisor as one implementation and a shared computer as another. A
  computer somewhere else is an adapter rather than a change to the governed path. Thanks to
  [@mu-hashmi](https://github.com/CopilotKit/OpenBot/pull/57) for the refactor.
- The address a provider hands back is checked before anything is sent to it, and the cloud metadata
  addresses are refused whatever a provider says.
- The container image runs as an unprivileged user rather than root.

## 0.0.1

First tag.

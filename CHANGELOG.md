# Changelog

What changed, for somebody deciding whether to upgrade. Written for the person running OpenBot, not
for the person who wrote the commit: a line belongs here when a deployment behaves differently
afterwards, and does not when only the code moved.

Newest first. `Unreleased` is what is on `main` and not yet tagged.

## Unreleased

### Added

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

- **Where a Bot's computer runs is now a plug.** One `ComputerProvider` interface sits under the
  gateway, with the Docker supervisor as one implementation and a shared computer as another. A
  computer somewhere else is an adapter rather than a change to the governed path. Thanks to
  [@mu-hashmi](https://github.com/CopilotKit/OpenBot/pull/57) for the refactor.
- The address a provider hands back is checked before anything is sent to it, and the cloud metadata
  addresses are refused whatever a provider says.
- The container image runs as an unprivileged user rather than root.

## 0.0.1

First tag.

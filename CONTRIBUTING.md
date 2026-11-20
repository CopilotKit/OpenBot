# Contributing to OpenBot

Thanks for helping. Open a pull request against `main` from your fork, and say in its description
what it changes and why.

## How CI runs on your pull request

- **A maintainer approves it first.** CI on a pull request from an outside contributor waits for a
  maintainer to approve it before it runs.
- **It runs on GitHub's standard runners, one contributor run at a time.** Runs from forks share one
  queue, so yours may wait for another contributor's to finish.
- **It may be paused when the team needs the runners.** If CopilotKit's own CI is waiting for a
  runner, contributor runs in progress are stopped and a comment on your pull request says so. Your
  CI re-runs on its own once the runners are free. Nothing is needed from you, and a pause says
  nothing about your change.
- **A new push starts a new run.** If you push again while a run is waiting, the newer commit is
  the one that gets checked.

Locally, `bun install` and then `bun test` runs the suite, `bun run lint` and `bun run format:check`
run the linters, and `bun run typecheck` checks the types.

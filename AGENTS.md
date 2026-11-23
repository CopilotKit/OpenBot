# Agents

**Before you change the API or the database, read
[docs/api-and-migrations.md](docs/api-and-migrations.md). Not optional.** That means anything under
`api/`, an app's requests (web app, OpenBot Desktop, the phone app, the Recorder), a database change,
or `release-policy.json`. OpenBot is live: anything a released app uses keeps working for 12 months,
and a migration never breaks a running server.

Skills for coding agents live in `.claude/skills/<name>/SKILL.md`. Claude Code finds them on its
own. Other agents: when a task matches a skill, read its `SKILL.md` before starting.

How to contribute, and the checks to run: [CONTRIBUTING.md](CONTRIBUTING.md).

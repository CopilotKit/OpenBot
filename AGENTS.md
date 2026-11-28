# Agents

**Before you change the API or the database, read
[docs/api-and-migrations.md](docs/api-and-migrations.md). Not optional.** That means anything under
`api/`, an app's requests (web app, OpenBot Desktop, the phone app, the Recorder), a database change,
or `release-policy.json`. OpenBot is live: anything a released app uses keeps working for 12 months,
and a migration never breaks a running server.

Before you plan a screen or a feature for the phone app, the web app or OpenBot Desktop, read
[docs/app-guidelines.md](docs/app-guidelines.md): the one color scheme every app keeps to, what the
phone app is for, and the stack it is built with.

**Before you change a token or a primitive, or build a screen from a design, read
[docs/design-system.md](docs/design-system.md). Not optional.** That means anything under `tokens/`
or `app/src/components/ui`, `app/src/theme.css`, a new font, icon set or picture, and any work
that starts from Figma. The design system stays compatible with shadcn, in light and in dark.

Skills for coding agents live in `.claude/skills/<name>/SKILL.md`. Claude Code finds them on its
own. Other agents: when a task matches a skill, read its `SKILL.md` before starting.

How to contribute, and the checks to run: [CONTRIBUTING.md](CONTRIBUTING.md).

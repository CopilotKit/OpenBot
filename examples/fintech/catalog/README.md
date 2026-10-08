# Coworkers to copy in

Nothing in this directory is loaded. Each file declares one coworker, in the shape `../agents/`
reads: copy a file into `../agents/` and the next start registers it. They used to load by
default, which put a dozen Bots in front of every new deployment at once.

The point of one file per coworker is that a coworker becomes a thing you can handle: copy one in,
delete one you do not want, send one to somebody. Nothing here is a grant. A coworker names skills,
a skill names tools, and what it may actually call is what an administrator has granted it, so a
file copied into `../agents/` adds an instruction and no capability.

These ten are meant to give you somewhere to start rather than to cover a matrix, and they are
deliberately unlike each other: finance, meetings, releases, support, onboarding, research, hiring,
reliability, procurement and product feedback. The part worth
copying is the shape of `role_description`: it says what the job is, what the coworker must not do,
and what to say when it cannot find something. A one-line description gets you a coworker that
answers vaguely.

More of them, outside this repository and not inherited by your clone:
[awesome-openbot-agents](https://github.com/jerelvelarde/awesome-openbot-agents).

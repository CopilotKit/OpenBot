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
reliability, procurement and product feedback.

Each file has two pieces of text, for two readers. `role_description` is the one sentence a person
reads under the Bot's name, and what OpenBot reads when it picks a Bot for a message. A Bot that
runs here is not given it as instructions. `system_prompt` is what the Bot runs on, and it is the part worth copying:
who the work is for, what to do in what order, what it must not do and why, and what to deliver
when part of the work comes back empty. Each one stays under the 1,000 characters the Bot form
allows, in plain sentences that give the reason for each rule. OpenBot's own prompt already tells
every Bot how to work (use what it has, take the step in the same reply, retry once, deliver with
gaps named), so a Bot's instructions only need to say what that means for its job.

More of them, outside this repository and not inherited by your clone:
[awesome-openbot-agents](https://github.com/jerelvelarde/awesome-openbot-agents).

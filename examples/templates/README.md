# The templates that ship in the box

A Bot template is one YAML file describing one coworker: its identity and its prose, the skills it
depends on, the capabilities it *asks* for, and a ceiling on what it may do. It carries no id, no
endpoint, no credential and no grant. See [docs/bot-templates.md](../../docs/bot-templates.md) for
the format.

These three are the seed of the catalogue. The `Dockerfile` copies `examples/` into the image, so
they travel with a deployment that has no network at all and can be imported by opening one and
pasting it in. They are also the worked examples: a template somebody writes by hand is read against
these.

They are deliberately **written rather than exported**. A template may not carry `type: built_in`
with a `system_prompt`, so exporting one of the shipped fintech Bots is not a faithful round trip —
which means the first catalogue entries have to be written, and that is what these are.

| File | What it is for |
| --- | --- |
| `research-desk.openbot.yaml` | Reads around a question and writes a brief that names every source. |
| `ticket-triage.openbot.yaml` | Decides what an incoming ticket is and drafts a reply for a person to send. |
| `competitor-watch.openbot.yaml` | Watches a fixed list of pages and says what actually changed. |

## Review rules

A file here is installed by strangers on deployments nobody in this repository can see, and it
arrives carrying this project's name. What follows is what a reviewer checks, in the order it is
worth checking.

1. **`bun scripts/check-bot-templates.ts` passes.** It parses every file with the same
   `parseBotTemplate` the server runs at preview and again at install, so the refusals — the
   environment-reference sequence, invisible codepoints, unknown keys, credential and endpoint key
   names, the size ceilings, the slug rule — are all asserted by it rather than by eye. It also
   checks the three things a parser cannot know: that the file is named after the template inside
   it, that the ask and the skills' declarations are the same set of tools, and that no skill slug
   collides with one `examples/*/skills.yaml` already seeds at every boot.

2. **Read every word of the prose out loud.** `role_description` and every `instructions` block are
   given to a model as instructions, and a reviewer skimming them is the only thing standing between
   an author and everybody who installs this. A sentence that would embarrass the project in a
   transcript is a review comment.

3. **The boundary is argued, not copied.** Each of `shell`, `files`, `browser`, `navigate_hosts` and
   `mcp` starts at the strictest thing the vocabulary can say. Anything wider than
   `shell: never`, `files: none`, `browser: none`, `mcp: read_only` needs a comment in the file
   saying which part of the job needs it — and the comment has to name a job, not a convenience. A
   template whose boundary is the same as the last one's, on a Bot that does a different job, has
   not been thought about.

4. **Every `why` is written for the person deciding.** These strings are rendered verbatim on the
   consent screen next to a grant somebody is about to make or refuse. "Needed for the integration"
   is not a reason. Name what the Bot does with the tool.

5. **The Bot is honest about what it will not do.** Where a Bot drafts rather than sends, decides
   rather than acts, or records rather than concludes, that has to be in `role_description` as well
   as in the skill — the role is what survives when the per-run selector loads a different skill.

6. **No host that is not a placeholder or genuinely public.** `navigate_hosts` in a shipped template
   names hosts an importer edits, so use `example.com`-style placeholders and say so in `notes`. A
   real customer's hostname in this directory is a leak, not a default.

7. **Nothing is a grant.** `requests:` is an ask. If a template appears to hand its Bot a
   capability, that is a bug in the format and not a feature of the file — say so on the pull
   request rather than working around it.

## Adding one

Write the file, name it `<template.slug>.openbot.yaml`, and run:

```sh
bun scripts/check-bot-templates.ts
```

CI runs the same command in the `static` job, so a file that does not parse fails the pull request
rather than somebody else's import — where the refusal is correct, arrives at the worst possible
moment, and is the author's mistake being reported to a stranger.

Nothing downstream fails loudly either, which is the other half of why the check matters. The
gallery reads this directory a file at a time: one that does not parse is logged as
`template-skipped` with the parser's own reason and passed over, and every other file still loads.
That is deliberate, because one author's typo must not stop somebody else's deployment booting —
but it means the consequence of shipping a broken file is a template that is quietly not in the
gallery, which nobody goes looking for. The check is where that becomes something a person sees.
The same is true of a second file claiming a slug another one here already uses: the first keeps
the name and the second is passed over, so name the file after the template inside it and the check
will hold you to it.

The wider catalogue is not this directory. Templates beyond the seed belong in
`jerelvelarde/awesome-openbot-templates`, curated on its own cadence; this directory stays small
enough that a reviewer can hold all of it in their head. A file there is held to the list above and
to this same script, vendored there as an Action so the two cannot drift. Two things differ. A
deployment reads that repository through a manifest at `openbot-templates.json` and reads nothing
else, so a template added without being named in it is invisible — generate the manifest from the
directory rather than keeping it by hand. And a deployment is pinned to a commit, so a fix lands
for somebody only when an administrator moves their pin.

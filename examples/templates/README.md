# The templates that ship in the box

A Bot template is one YAML file describing one coworker: its identity and its prose, the skills it
depends on, the capabilities it *asks* for, and a ceiling on what it may do. It carries no id, no
endpoint, no credential and no grant. See [docs/bot-templates.md](../../docs/bot-templates.md) for
the format.

There are 27 of them, across the 9 kinds of work a category may name. The `Dockerfile`
copies `examples/` into the image, so they travel with a deployment that has no network at all and
can be imported by opening one and pasting it in. They are also the worked examples: a template
somebody writes by hand is read against these.

The set is deliberately varied rather than uniform — some ask for no connectors at all, one runs
remote, one buys exactly a single write — so that it demonstrates the boundary vocabulary instead of
repeating one shape 27 times. What each one is really carrying is a rule about judgement: what it
must not conclude, and what it says when the evidence is thin.

They are deliberately **written rather than exported**. A template may not carry `type: built_in`
with a `system_prompt`, so exporting one of the shipped fintech Bots is not a faithful round trip —
which means the first catalogue entries have to be written, and that is what these are.

| File | Category | What it is for |
| --- | --- | --- |
| `account-health.openbot.yaml` | customer-success | Reads one account's own record and says what the evidence supports about its health, naming what is missing rather than filling it in. Gives no score. |
| `account-research.openbot.yaml` | sales | Prepares one company before a meeting from what they publish and what we already recorded, and keeps the two apart so nobody repeats a claim back as a fact. |
| `beta-adoption.openbot.yaml` | product | Says which accounts have actually used a feature in the beta, against the roster of who was let in, and keeps "did not use" apart from "not measured". |
| `campaign-brief.openbot.yaml` | marketing | Turns a request for a campaign into a brief somebody can build from, and marks what nobody has answered as an open question rather than filling it in. |
| `chief-of-staff.openbot.yaml` | general | Keeps a written record of what people said they would do, and says what has slipped without chasing anybody. |
| `claims-desk.openbot.yaml` | marketing | Checks every factual claim in a marketing draft against a document we can name, and refuses to approve, rewrite or treat our own earlier copy as evidence. |
| `competitor-watch.openbot.yaml` | marketing | Watches a fixed list of competitor pages, says what actually changed since last week, and refuses to dress a change up as a conclusion. |
| `escalation-watch.openbot.yaml` | customer-success | Watches open threads for a commitment that has been missed, and drafts the handover for a person to send. Escalates nothing itself. |
| `expense-review.openbot.yaml` | operations-finance | Reads one expense claim against the policy as it is written, quotes the clause that applies, and leaves the decision to a person. |
| `feedback-digest.openbot.yaml` | product | Groups what customers actually said into themes, keeps every theme attached to the sentences that produced it, and never promotes a suggestion into a commitment. |
| `inbox-first-pass.openbot.yaml` | life | Reads a morning's messages where they already live and says which few need you today. Answers none of them. |
| `interview-notes.openbot.yaml` | recruiting | Turns what an interviewer says into a written record: the question, the answer and what was observed, kept apart from what was concluded. Asks for nothing. |
| `invoice-chaser.openbot.yaml` | operations-finance | Works out which invoices are actually overdue, drafts the follow-up a person sends, and can hold the weekly chase to a schedule. |
| `meeting-follow-ups.openbot.yaml` | general | Turns one set of meeting notes into the follow-ups actually in them, each with the line it came from, and leaves the unowned ones unowned. |
| `onboarding-buddy.openbot.yaml` | recruiting | Answers a new starter's questions from the written handbook, quotes the passage, and books the first fortnight's check-ins. Hands anything with a legal edge to a person. |
| `oncall-handover.openbot.yaml` | engineering | Writes the handover one on-call shift leaves the next: what fired, what is still open, and what the log does not say. |
| `outbound-desk.openbot.yaml` | sales | Reads what we already know about an account and drafts a first-touch note for a person to send. Never sends anything, and never invents a reason to write. |
| `paid-media-desk.openbot.yaml` | marketing | Reports what paid spend did over a stated window, from an agent your own team runs, and refuses to explain a movement or recommend a budget. |
| `product-performance.openbot.yaml` | product | Answers questions about how the product is doing through your own metrics service, and names the definition and the window behind every number it gives. |
| `release-notes.openbot.yaml` | engineering | Turns a list of merged changes into release notes a customer can read, and counts the ones with no visible effect rather than dressing them up. |
| `renewal-prep.openbot.yaml` | customer-success | Assembles the pack for a renewal conversation and refuses to write the ask. Runs on a service you host yourself, so the whole conversation leaves this deployment. |
| `renewal-watch.openbot.yaml` | sales | Reads renewal dates and notice periods off the contract, lists what is coming, and refuses to turn a quiet account into a risk score. |
| `repro-desk.openbot.yaml` | engineering | Follows a bug report step by step on a site you name, says whether it reproduces, and does not diagnose it. |
| `research-desk.openbot.yaml` | general | Reads around a question and writes a short brief that names every source it used. |
| `talent-scout.openbot.yaml` | recruiting | Reads a role's written requirements, then finds published evidence against each one and gives the address it was read on. Does not rank people and contacts nobody. |
| `ticket-triage.openbot.yaml` | customer-success | Reads an incoming ticket, works out what it actually is, and hands a person a draft reply and a reason. Never answers the customer itself. |
| `vendor-review.openbot.yaml` | operations-finance | Assembles what is actually known before a renewal — the terms we signed, what we spent, and what the vendor publishes today — and recommends nothing. |

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

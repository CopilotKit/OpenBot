# Bot templates

A Bot template is one YAML file describing one coworker: its identity and its prose, the skills it
depends on, the capabilities it *asks* for, and a ceiling on what it may do. It is exported from a
coworker's profile, sent by any means a file travels, and imported through a consent screen that
shows the importer every word a stranger wrote before any of it reaches a model.

**Configuration travels; capability does not.** A template carries no id, no endpoint, no
credential, no MCP grant, no component source and no policy rule, because none of those are fields:
a document containing one fails to parse rather than being quietly stripped. What the coworker
wanted instead lands in a ledger as *requested and not granted*, and an administrator satisfies it
afterwards on the grant screens that already exist.

The vocabulary is the tenant package's, so anybody who has read [configuration.md](configuration.md)
and `examples/fintech/` can read a template. Three worked examples ship in
[`examples/templates/`](../examples/templates/README.md).

## What travels

| Piece | Verdict | Why |
| --- | --- | --- |
| Name, title, role description | Carried | The standing role, sent with every run. |
| `avatar_seed` | Carried | An opaque style token, never an id. |
| Runtime kind | Carried as `managed` or `remote` | A `built_in` Bot with a system prompt cannot be expressed in v1. |
| Skills: slug, title, summary, instructions | Carried | Pure text. A skill is an instruction and confers nothing. |
| Skill tool declarations | Carried, unvalidated | Shipping refs for connectors nobody has added yet is the point. |
| The Bot-to-skill pairing | Carried | The one grant an import makes, without which per-run narrowing never switches on. |
| The boundary block | Carried | A closed vocabulary the author writes, compiled locally. |
| The endpoint | Never carried, rebound | The importer types the address, checked against *this* deployment's allowlist. |
| The auth header *name* | Carried | A header name is not a secret; the value is typed by the importer. |
| A credential, a key, a vault pointer | Never | No field can hold one, and the key names are refused by name. |
| Agent id, package id, owner, visibility | Never | Minted, forced private, and owned by whoever imported it. |
| MCP grants | **Requested only** | A grant reaches a person's own account. It is asked for, never written. |
| Component **names** | Requested only | A name that names nothing is inert. |
| Component **source** | Never | Component source *is* the component: executable code. |
| MCP servers, credentials, channels, knowledge, branding, theme, model | Never | Deployment configuration, not a coworker. |
| Audit rows | Never | A path that could write history is a way to fabricate a trail. |

## The format

```yaml
openbot_template: 1                 # FORMAT version. An unknown value is refused.

template:
  slug: renewal-desk                # names the file only
  version: "1.3"                    # the author's string. Nothing reads it.
  author: acme-revops               # a CLAIM. Rendered as a claim. Never verified.
  source: https://github.com/acme/openbot-templates
  summary: Chases overdue invoices and drafts the follow-up.
  license: Apache-2.0

bot:
  name: Renewal Desk
  title: Accounts Receivable
  role_description: >-
    Chase overdue invoices. Find the ledger, work out who is late and by how much, and draft a
    follow-up for a person to send. Name every document you used. Never send anything yourself.
  avatar_seed: renewal-desk
  runtime: managed                  # managed | remote
  skills: [check-renewal-risk]      # must be defined below, or the file is refused

skills:
  - slug: check-renewal-risk
    title: Check renewal risk
    summary: Pull the contract, the recent tickets and the usage trend for one account.
    instructions: >-
      Before answering anything about an account's renewal, find the contract and read the renewal
      date and notice period from it. Name each document you used.
    tools:                          # DECLARATIONS. No grant, no validation.
      - google-drive/search_files
      - google-drive/read_file_content

requests:                           # the ask. NOTHING here is written as a permission.
  connectors:
    - id: google-drive
      why: The invoice ledger export lives in Drive.
      tools:
        - ref: google-drive/search_files
          why: Find the ledger for one customer.
        - ref: google-drive/read_file_content
          why: Read amounts and due dates.
  components:
    - name: showBarChart
      why: Ageing buckets.

boundary:                           # a CLOSED vocabulary. A template never writes CEL.
  shell: never                      # never | permitted
  files: none                       # none | read_only | read_write
  browser: read_only                # none | read_only | full
  navigate_hosts:                   # exact hostnames, compiled to equality, never a pattern
    - billing.acme.example
  mcp: read_only                    # none | read_only | read_write

notes: >-                           # free text for the importer. Never reaches a model.
  Point this at whichever Drive folder holds your contracts.
```

### Every key

`openbot_template` is required and must be `1`. Any other value is refused rather than read
leniently: a future format that means something different by the same key names must not be
half-understood by an older deployment.

| Key | Required | Limit | Notes |
| --- | --- | --- | --- |
| `template.slug` | yes | 40 | Names the file and nothing else. |
| `template.version` | no | 40 | The author's string. Nothing reads it; there is no update channel. |
| `template.author` | no | 80 | A claim, rendered as one, never verified. |
| `template.source` | no | 200 | Must be `https://` with a plain host and no credential. Rendered as text, never dialled. |
| `template.summary` | yes | 300 | One line, shown in a list. |
| `template.license` | no | 40 | A claim like the rest of the block. |
| `bot.name` | yes | 80 | Checked by the same helper the edit form uses, so an import can never land a Bot that screen would refuse to save. |
| `bot.title` | yes | 120 | |
| `bot.role_description` | yes | 1000 | Given to a model as instructions. Rendered verbatim on the consent screen. |
| `bot.avatar_seed` | no | 40 | An opaque style token. Never an id. |
| `bot.runtime` | yes | — | `managed` or `remote`. |
| `bot.skills` | no | 25 | Slugs, every one of which this same file must define. |
| `bot.remote` | only for `remote` | — | See below. |
| `skills[].slug` | yes | 40 | |
| `skills[].title` | yes | 120 | |
| `skills[].summary` | yes | 300 | Load-bearing beyond display: it is the index the per-run skill selector reads. |
| `skills[].instructions` | yes | 8000 | Rendered verbatim on the consent screen. |
| `skills[].tools` | no | 40 total | `<serverId>/<toolName>`. Declarations, not grants, and deliberately not checked against anything. |
| `requests.connectors[].id` | yes | 40 | A connector id, such as `google-drive` or `notion`. |
| `requests.connectors[].why` | yes | 300 | Shown verbatim beside the ask. |
| `requests.connectors[].tools[].ref` | yes | 120 | Must begin with the id it is filed under. |
| `requests.components[].name` | yes | 80 | A component name. Naming one that is not in the build is reported, not refused. |
| `boundary.*` | no | — | Absent means the strictest thing the vocabulary can say. |
| `notes` | no | 4000 | For the importer. Never reaches a model. |

A slug — `template.slug`, a skill slug, `avatar_seed` — is `^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`. That
is the Skills API's rule rather than the tenant package's looser one, which admits `x` and `find-`:
both install cleanly through a package and are then permanently uneditable through the product,
because the API refuses to save what the package was allowed to create.

The whole document is capped at 128 KiB, 25 skills, 40 tool refs and 40 requested things.

### `bot.remote`

There is no `url` key, in any block. A remote template describes where its Bot *would* live; the
importer types the address, and it goes through the same target checks as browser navigation, at
registration and again on every redirect the endpoint answers with.

| Key | Notes |
| --- | --- |
| `auth_header` | The header *name*. Not a secret, and already stored unencrypted. |
| `requires_key` | Whether the importer will be asked for a key. A claim. |
| `example_url` | Documentation for the person typing the address. Never dialled. |
| `sends_conversation_to` | A plain hostname the author claims conversations go to, shown on the consent screen and compared with what was typed. |

### `boundary`

A closed vocabulary rather than a policy rule. A template never writes CEL, host lists compile to
equality tests rather than to patterns, and the block can only ever say *less* than the deployment
already allows.

| Key | Values | Default when absent |
| --- | --- | --- |
| `shell` | `never`, `permitted` | `never` |
| `files` | `none`, `read_only`, `read_write` | `none` |
| `browser` | `none`, `read_only`, `full` | `none` |
| `navigate_hosts` | up to 20 plain hostnames | none, which adds no host clause |
| `mcp` | `none`, `read_only`, `read_write` | `read_only` |

An author who wrote no boundary did not decide one, and the safe reading of "did not decide" is not
"may do anything". `mcp` is the exception, and is `read_only` rather than `none`, because an MCP
grant is refused by absence anyway.

**The ceiling is not yet enforced.** Computer actions are gated by who may use the Bot plus the
deployment-wide action policy, and the shipped default permits everything. Until the boundary
compiler ships, an imported Bot can browse, read and write files and run shell commands exactly like
a Bot you built yourself. Write the block anyway — it is what the consent screen shows and what the
compiler will read — and narrow the deployment on `/admin/boundaries` in the meantime.

## Export

`POST /api/agents/:agentId/template`, from **Export template** on a coworker's profile panel.

It produces a **draft** the author reads and edits before it leaves the building, not a one-shot
download. The response carries the file, its digest, and — the interesting half — a list of what was
stripped, in sentences. The draft is stored per author and per slug; a second export of the same
coworker answers 409 rather than throwing away the edits made to the first.

Exporting a package Bot is deliberately allowed. They are ownerless, public, and the most
template-worthy things in the product.

Two things refuse an export rather than warning about it. A coworker the format cannot express — a
skill slug the API rule does not admit, prose past a ceiling — because a silently truncated
instruction is an instruction nobody wrote. And prose carrying something shaped like a credential,
for the harder reason: the file is about to be handed to somebody.

The exported boundary is always the strictest one, whatever this Bot could do here. Nothing records
that a coworker ever ran a shell command, and the action policy it ran under is one row for the
whole deployment rather than a fact about that coworker — so deriving a boundary from what it was
*allowed* would export a permissive deployment's settings as a coworker's requirements, and that
permissiveness would travel to everyone who imported the file.

| Route | Who | Purpose |
| --- | --- | --- |
| `POST /api/agents/:agentId/template` | Anyone who can manage the Bot, or any signed-in person for a package Bot | Pack a coworker into a draft. |
| `GET /api/templates` | Signed in | Your drafts; an administrator sees the deployment's. |
| `PATCH /api/templates/:templateId` | Owner or administrator | Re-runs the parser and the secret scanner. |
| `GET /api/templates/:templateId/file` | Owner or administrator | The file itself. |
| `DELETE /api/templates/:templateId` | Owner or administrator | |

## Import

Paste or drop the file. Nothing is written until the last button.

`POST /api/templates/preview` writes nothing and, on success, records nothing — a preview that left a
row would make reading a stranger's file indistinguishable from installing it. It returns the parsed
document, a digest, and a plan: which connectors exist here, which skill slugs are already taken and
how each collision would be resolved, which named components are in this build, and whether an
address is needed.

The consent screen has a fixed order, and the first section is the one that matters:

1. **What this Bot is.** Name, title, avatar, and the `role_description` verbatim, unabridged, in a
   scrollable monospace block, headed by the fact that this text is given to a model as instructions
   and was written by a stranger. You cannot consent to text you were not shown.
2. **Its skills.** Each with its full instructions shown the same way, and how a colliding slug will
   be resolved.
3. **Where it runs.** For `managed`, on this deployment's own Bot. For `remote`, the origin in large
   type and the sentence that every message anyone sends this coworker is sent to that address.
4. **What it is asking for.** Every request with the author's `why`, each tagged as not granted by
   this install. There is no checkbox; granting is a separate act on a separate screen.
5. **What it will be allowed to do.** The boundary in plain English, with anything looser than the
   strict default flagged.
6. **What this install will not do.**

`POST /api/templates/install` carries the digest the preview returned, and the server recomputes it
and answers 409 if it moved — closing the window where the file changes between the consent screen
and the click. Every refusal is re-run server-side, and the whole install is one transaction: a
mid-install failure leaves no orphan Bot, no orphan skill and no half-written trail.

A colliding skill slug is never overwritten. The importer chooses per slug: reuse the existing skill
if it is byte-identical, install under a suffixed slug, or skip it. Overwriting would silently take
somebody's `/` command.

An unmet request never blocks the install. Blocking would make "grant everything" the fastest route
to a working Bot, which inverts the feature.

## Afterwards

The Bot arrives **cold**: private, owned by the importer, with its skills, and possibly zero MCP
grants. It does not lie about this — a Bot's self-description is built from the tools it was actually
offered, so a cold Bot says it has no source rather than claiming what the template promised.

Its profile shows a **Requested, not granted** list, each row carrying the author's `why` and, for an
administrator, a Grant button posting to the routes that already decide those things. Warming a Bot
up is a series of individually audited authorizations, never a re-import.

Imported skills are the importer's, with `origin: 'template'`. Grants an import made carry
`granted_by = template:<first twelve characters of the digest>`, mirroring the tenant package's own
sentinel, which is what makes retraction exact: `DELETE /api/templates/imports/:agentId` takes back
only what this import gave and leaves a grant an administrator made by hand untouched. It does not
delete the Bot or any skill.

| Route | Who | Purpose |
| --- | --- | --- |
| `POST /api/templates/preview` | Signed in | Writes nothing. Refusals are recorded. |
| `POST /api/templates/install` | Signed in | 409 if the digest moved. |
| `GET /api/templates/imports/:agentId` | Anyone who may use the Bot | The ledger. 404 rather than 403. |
| `POST /api/templates/imports/:agentId/requests/:kind/:ref/grant` | Administrator | Acts on the ledger, never on the file. |
| `POST …/decline` | Administrator | |
| `DELETE /api/templates/imports/:agentId` | Owner or administrator | Retract. |

Every step is on the audit trail, with both outcomes recorded: `template.exported`,
`template.import_refused`, `bot.created`, `template.imported`,
`template.capability_requested`, `template.capability_granted`, `template.capability_declined`,
`template.boundary_applied`, `template.boundary_removed`, `template.retracted`. Never the prose,
never a key.

## The refusals

The parser reads the file as bytes before it reads it as a document, and refuses rather than
sanitising. Each refusal names itself.

| Reason | What it means |
| --- | --- |
| `format_version` | `openbot_template` is not `1`. |
| `unknown_key` | A key at any level that is not part of the format. |
| `forbidden_field` | A key named for a credential, an endpoint, a package id, an owner, a visibility, a system prompt or a policy rule. Named separately so the author is told *why*, not just that it is unknown. |
| `interpolation` | The two characters that open an environment reference, anywhere in the document, comments included. |
| `invisible_character` | A format character, private-use codepoint, bidi control, zero-width or tag character. |
| `too_large`, `too_many`, `too_long` | A ceiling above. |
| `bad_slug`, `bad_tool_ref`, `bad_hostname`, `bad_url` | A shape rule above. |
| `unknown_skill` | `bot.skills` names a skill the file does not define. |
| `missing_field`, `bad_type`, `malformed_yaml` | The document does not have the shape it claims. |

Unknown keys are refused here where a tenant package ignores them, and that difference is deliberate.
An operator's own directory carrying a stale key from an older version should not stop a deployment
booting. A stranger's file is the other case: an ignored key is a key the reviewer's eye slid over
and the parser agreed to.

The environment-reference refusal is the sharpest divergence from the tenant package, which expands
`${...}` textually out of the server's own environment. In a package that is how one file serves a
laptop, a staging stack and production. In a stranger's file it is an exfiltration primitive: a role
description naming the deployment's key-encryption key would be expanded, stored, shown to a model
and readable afterwards. There is no allowlist of names and no escaping.

## Security posture

| Attack | Defense |
| --- | --- |
| A template exfiltrates the importing deployment's secrets through prose | The environment-reference sequence is a parse refusal, checked against the raw bytes. |
| A template ships a working credential | No field can hold one, and the key names are refused by name, so such a file fails loudly rather than being quietly stripped. Export scans for secret shapes too. |
| A template points users' conversations at the author's server | The format has no `url` field. Unrepresentable rather than gated. |
| A template hides a payload from the consent screen | Invisible codepoints are refused. A review control that can be made invisible is not a control. |
| A template pre-seeds an MCP grant that goes live when an admin adds the connector | The import has no code path that writes an MCP grant. |
| A template overwrites somebody's `/` command | An import never installs onto a slug that is taken. |
| A template ships executable component code | Component source is not a key, in any phase. |
| Auto-update turns one bad template into mass compromise | There is no update channel. Re-importing creates a separate Bot, and an installed Bot no longer refers to its template. |
| Prompt injection in the prose steers the Bot | Only partly closed. Nothing evaluates prose; the firewall is at the tool call. What is closed: the invisible-character refusal, verbatim unabridged rendering, an importer-owned private Bot, and — once it ships — the compiled per-Bot boundary. |
| Publisher compromise, typosquatting | Not defended, and not defensible without identity infrastructure. `template.author` is a claim. For a file somebody hands you, the model is that you read it. |

Under `OPENBOT_SINGLE_USER` every authorization gate here is vacuous, because everyone is the
administrator. The refusals are identical: there is no relaxation for a laptop, because the
single-user flag is what a laptop and a carelessly-exposed VM have in common.

## Where templates come from

Three ways, and none of them is a service OpenBot runs.

1. **A file somebody sends you.** Slack, a gist, a pull request comment. Import is a paste box, and
   this needs no infrastructure at all.
2. **The seed in the image.** [`examples/templates/`](../examples/templates/README.md) ships three
   worked templates, copied into the container, so a deployment with no network has something to
   start from. Its README carries the rules a new one is reviewed against.
3. **A curated repository**, `jerelvelarde/awesome-openbot-templates`: `*.openbot.yaml` files an
   administrator registers as a source, pinned to a commit sha and fetched server-side, so the
   browser never acquires a third-party origin and the source never sees an end user's address.
   Nothing is fetched unless an administrator registers a source.

Moving a pin is the only update mechanism, it is a deliberate act, and it changes nothing already
installed. That is what makes the absence of an update channel safe rather than merely cheap.

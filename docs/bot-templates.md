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
and `examples/fintech/` can read a template. Twenty-seven worked examples ship in
[`examples/templates/`](../examples/templates/README.md).

## What travels

| Piece | Verdict | Why |
| --- | --- | --- |
| Name, title, role description | Carried | The standing role, sent with every run. |
| `avatar_seed` | Carried | An opaque style token, never an id. |
| Runtime kind | Carried as `managed` or `remote` | Neither `type: built_in` nor a system prompt is a field. `managed` says *this deployment*; which of the two ways of running here that becomes is this deployment's decision, not the file's. |
| Skills: slug, title, summary, instructions | Carried | Pure text. A skill is an instruction and confers nothing. |
| Skill tool declarations | Carried, unvalidated | Shipping refs for connectors nobody has added yet is the point. |
| The Bot-to-skill pairing | Carried | The one grant an import makes, without which per-run narrowing never switches on. |
| The boundary block | Carried | A closed vocabulary the author writes, compiled locally. |
| The endpoint | Never carried, rebound | A `remote` template's address is typed by the importer and checked against *this* deployment's allowlist. A `managed` one is never asked for. |
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
  category: sales                   # a CLOSED list. Any other value is refused.
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
| `template.summary` | yes | 300 | Up to three lines on a gallery card, the description heading the template's own page, and in full on the consent screen. |
| `template.category` | no | — | One of `general`, `sales`, `marketing`, `customer-success`, `recruiting`, `operations-finance`, `product`, `engineering`, `life`. A closed list rather than free text, because the gallery groups and filters by it: a stranger's file must not be able to invent a grouping, put prose in a chip, or sort itself to the top. Absent is uncategorised. |
| `template.license` | no | 40 | A claim like the rest of the block. |
| `bot.name` | yes | 80 | Checked by the same helper the edit form uses, so an import can never land a Bot that screen would refuse to save. |
| `bot.title` | yes | 120 | |
| `bot.role_description` | yes | 1000 | Given to a model as instructions. Rendered verbatim on the consent screen. |
| `bot.avatar_seed` | no | 40 | An opaque style token. Never an id. |
| `bot.runtime` | yes | — | `managed` or `remote`. Only `remote` asks the importer for an address; see below. |
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

### `bot.runtime`

`managed` means this deployment and `remote` means somewhere else, and only `remote` asks the
importer for an address.

A deployment configured with a Bot in the box registers a `managed` coworker against it, the way the
Coworkers screen does. A deployment with no such Bot — which is what the recommended one-container
image is — binds the coworker in-process instead, on the `role_description` the file already
carries. Where it runs differs between the two; what it is told does not.

Asking for an address in the second case would be wrong twice over. It contradicts the template's
own page, which says the coworker runs on this deployment: a consent screen demanding an address two
clicks later reads the same field and disagrees with it. And the cheapest way past such a demand is
to register a third party's endpoint in order to try a template, after which every message anybody
sends that coworker leaves the network — the position the rest of this format is written to keep
people out of.

Nothing about what travels changes here. `type: built_in` is still not expressible, `system_prompt`
is still refused by name, and exporting a coworker whose behaviour lives in a system prompt is still
not a faithful round trip. `role_description` is not a second way to write one: it is the field that
was already given to a model as the standing role, and already rendered verbatim on the consent
screen under the sentence saying a stranger wrote it. Binding it in-process shows a model nothing it
was not going to be shown.

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

**The ceiling is enforced.** Each line of the vocabulary is compiled at import into a deny clause
this deployment wrote, scoped to the one Bot the file arrived with: `bot.id == "<the new Bot>" &&
(…)`. The permissive end of a key compiles to nothing at all, because a ceiling only ever subtracts
and a stored rule saying a coworker *may* run commands would read on the Boundaries screen as though
a stranger's file had conferred something. Host lists compile to equality tests rather than to
patterns: a pattern function throws on something it cannot parse, a throwing expression in a deny
list counts as a match, and a generated clause that matched everything would refuse every action the
coworker ever attempted rather than the navigation it was about.

The clauses are not written into the deployment's own action policy, and that is a storage decision
rather than a tidy one. That policy is one row for everybody, replaced wholesale by the next
administrator who saves the Boundaries screen with no version column in between — so a per-Bot clause
kept there would be erased by an unrelated save and the coworker would quietly come uncaged, with
nothing anywhere saying it had happened. They live in `template_boundaries` instead. The policy store
composes the two lists for evaluation and for nothing else, and `/admin/boundaries` renders them in a
read-only group, **Applied by an import**, which says in a sentence that saving that screen neither
adds nor removes any of them. Retracting the import retires them in one act.

Every clause is evaluated before the import commits, against a synthetic context and through the same
engine that will judge it afterwards, and one that throws or answers with anything other than a
boolean refuses the whole import rather than being stored. No Bot at all is the right outcome there:
a coworker running looser than the screen its importer read is worse than an import that did not
land.

Two limits on all of this, both said on the consent screen and both read from the live policy. The
ceiling only subtracts, so wherever the author left a key at its permissive end the coworker inherits
whatever this deployment allows — which, on the shipped policy, is everything. And a deployment set
to record what it would have refused rather than refuse it does not enforce these clauses either:
that setting governs the whole evaluation, and they are judged by it like any other rule.

## The screens

Reading a stranger's template changes nothing, and the shape of these screens is where that is
enforced rather than promised. Browsing, reading and installing are three separate URLs: the middle
one exists so that "let me see what this is" and "I am installing this" are not the same
gesture, and a card never opens the consent screen directly.

```text
Bot templates — what leads to what. A branch is the control a person presses.

  ·  this screen writes nothing at all        !  this control writes

ANYONE SIGNED IN

·  /agents                                     the coworkers you have
   ├──   "Templates"                        →  the gallery, below
   ├──   "Import"                           →  the consent panel, below,
   │                                           at /agents?import=true[&template=<id>]
   ├──   "Start channel"                    →  /channel/new
   └──   a coworker                         →  its profile panel, below

·  /agents/gallery                             what it offers, and what it would not list
   ├──   "Coworkers"                        →  /agents
   └──   "Read this template"               →  /agents/gallery/$slug

·  /agents/gallery/$slug                       read in full. Nothing is decided here.
   ├──   "Templates"                        →  /agents/gallery
   └──   "Use this template"                →  the consent panel, at ?use=<slug>

!  the consent panel                           one component, two URLs, not a route
   ├──   "Read this template"                  previews the pasted file; persists nothing
   ├──   "Test"                                dials what you typed; persists nothing
   ├──   "Read a different file"               back to the paste box
   ├──   "Set a boundary"                   →  /admin/boundaries (administrator only)
   └── ! "Import <Bot name>"                   the install, then → /agents?agent=<id>

!  /agents?agent=<id>                          one coworker, in a panel over the roster
   ├── ! "Grant" / "Decline"                   answers one ask. Administrator only.
   ├── ! "Export template"                     packs this coworker into a draft
   ├── ! "Re-pack from the coworker"           replaces the draft, your edits and all
   ├── ! "Save changes"                        saves your edits to the draft
   ├──   "Show the file" / "Hide the file"     reveals it; "Copy" copies it
   └──   "Download"                            the saved file; off while edits are unsaved

ADMINISTRATOR ONLY

·  /admin                                      Templates sits under "What Bots can reach"
   └──   "Templates"                        →  /admin/templates

!  /admin/templates                            who may install, sources, every import
   ├── ! "Administrators only"                 the switch; an env floor can hold it
   ├──   "Register a source"                →  a dialog: ! "Register", "Cancel"
   ├── ! "Forget"                              drops a pinned source
   └──   an imported coworker               →  its ledger: the asks, the ceiling applied
       ├──   "Boundaries"                   →  /admin/boundaries
       ├── ! "Retract"                         takes back that import's grants and ceiling
       └──   "Close"

!  /admin/boundaries                           its own rules; import clauses are read-only
   ├── ! "Add rule" / "Remove"                 the deployment's own, never an import's
   ├──   "Audit"                            →  /admin/audit
   └──   the coworker's name                →  /agents

·  /admin/audit                                the "Blocked" and "Did not happen" filters
```

The consent panel is the same component at both of its URLs — a slide-over rather than a route —
and only its last button writes. An install grants nothing, so **Grant** and **Decline** live on
the coworker's own profile against the live grant tables, never in the administrator's ledger.

## Export

`POST /api/agents/:agentId/template`, from **Export template** on a coworker's profile panel.

It produces a **draft** the author reads and edits before it leaves the building, not a one-shot
download. The response carries the file, its digest, and — the interesting half — a list of what was
stripped, in sentences. The draft is stored per author and per slug.

A second export of the same coworker hands back the draft that already exists, edits intact, and
carries the file a fresh pack would have written as `repack`. The panel says the draft was already
there and offers **Re-pack from the coworker**, which replaces the document — edits included — back
through the draft route that re-parses and re-scans it, so bytes this server produced are trusted no
further than a stranger's. Only a name taken by a draft for a *different* Bot answers 409, because
only a person can decide which of the two keeps it.

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

Paste the file. Nothing is written until the last button. There is no drop target and no file
picker: the import screen is a paste box, and a gallery entry or one of your own drafts seeds that
same box with the YAML this server serialised from the document it parsed.

`POST /api/templates/preview` writes nothing and, on success, records nothing — a preview that left a
row would make reading a stranger's file indistinguishable from installing it. It returns the parsed
document, a digest, and a plan: which connectors exist here, which skill slugs are already taken and
how each collision would be resolved, which named components are in this build, and where the
coworker would run — the Bot in the box, in-process here, or an address the importer has yet to
type.

The consent screen has a fixed order, and the first section is the one that matters:

1. **What this Bot is.** Name, title, avatar, and the `role_description` verbatim, unabridged, in a
   scrollable monospace block, headed by the fact that this text is given to a model as instructions
   and was written by a stranger. You cannot consent to text you were not shown.
2. **Its skills.** Each with its full instructions shown the same way, and how a colliding slug will
   be resolved.
3. **Where it runs.** For `managed`, on this deployment: its own Bot where one is configured, and
   in-process here where none is, in which case the role description above is the whole of what the
   coworker is told. Neither asks for an address. For `remote`, the origin in large type and the
   sentence that every message anyone sends this coworker is sent to that address.
4. **What it is asking for.** Every request with the author's `why`, each tagged as not granted by
   this install. There is no checkbox; granting is a separate act on a separate screen.
5. **What it will be allowed to do.** The boundary in plain English, said as sentences rather than in
   the vocabulary's words, with what this deployment does about it read from the live policy: whether
   it refuses what it matches, and whether the deployment allows everything around it.
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
delete the Bot or any skill. The ceiling goes with the grants, in the same act: a coworker that no
longer holds what the template gave it is not left narrowed by what that template asked for, and the
retired clauses stay on the trail as `template.boundary_removed` rather than disappearing.

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
| Prompt injection in the prose steers the Bot | Only partly closed. Nothing evaluates prose; the firewall is at the tool call. What is closed: the invisible-character refusal, verbatim unabridged rendering, an importer-owned private Bot, and the compiled per-Bot boundary, which is this deployment's own rules rather than the author's. |
| Publisher compromise, typosquatting | Not defended, and not defensible without identity infrastructure. `template.author` is a claim. For a file somebody hands you, the model is that you read it. |

Under `OPENBOT_SINGLE_USER` every authorization gate here is vacuous, because everyone is the
administrator. The refusals are identical: there is no relaxation for a laptop, because the
single-user flag is what a laptop and a carelessly-exposed VM have in common.

## Where templates come from

Three ways, and none of them is a service OpenBot runs.

1. **A file somebody sends you.** Slack, a gist, a pull request comment. Import is a paste box, and
   this needs no infrastructure at all.
2. **The seed in the image.** [`examples/templates/`](../examples/templates/README.md) ships
   twenty-eight worked templates, copied into the container, so a deployment with no network has
   something to start from. Its README carries the rules a new one is reviewed against.
3. **A curated repository**, `jerelvelarde/awesome-openbot-templates`: `*.openbot.yaml` files an
   administrator registers as a source, pinned to a commit sha and fetched server-side, so the
   browser never acquires a third-party origin and the source never sees an end user's address.
   Nothing is fetched unless an administrator registers a source.

Moving a pin is the only update mechanism, it is a deliberate act, and it changes nothing already
installed. That is what makes the absence of an update channel safe rather than merely cheap.

The second and third are the catalogue: what `/agents/gallery` lists, and what `/admin/templates`
configures. A gallery entry is a stranger's file that arrived by a different road, so opening one
runs the preview and the install through every refusal a paste goes through. There is no search, no
install count and no rating: there is nothing to count, and a count is a thing to forge.

### The directory in the image

`OPENBOT_TEMPLATE_DIR` names it, defaulting to `../examples/templates` and resolved from `server/`
exactly as `TENANT_PACKAGE_DIR` is. The `Dockerfile` copies `examples/` into the image, so this is
populated on a deployment that has no network at all and never registers a source.

Every `.yaml` and `.yml` file in it is measured before it is read and parsed on its own. **A file
that does not parse is passed over, named, and logged as `template-skipped` with the parser's own
refusal reason, and the rest of the directory still loads.** That is the one deliberate divergence
from the tenant package loader, which lets a malformed `agents.yaml` stop the process before it
serves. A package is one operator's own configuration and a deployment running half of it is worse
than one that did not come up; a template directory is many authors' files, and one person's typo
must not stop somebody else's deployment booting. It is the judgement the package sync already makes
for a colliding skill slug: name what was passed over, and keep going.

Two files claiming one slug is the same case — first taker keeps the name, the second is passed over
as `duplicate_slug` — because the alternative makes what a gallery shows depend on the order a
directory happened to come back in. A directory that is not there at all is an empty gallery with a
skip naming it, never a refusal to start.

A skip is data as well as a log line. Every listing carries what it could not read alongside what it
could, so the gallery can say "three templates, one skipped" rather than leaving somebody to notice
an absence.

### A pinned git source

The catalogue beyond the seed is `jerelvelarde/awesome-openbot-templates`, a public repository of
`*.openbot.yaml` files curated on its own cadence. An administrator registers it on
`/admin/templates` as `owner/repo` **pinned to a full 40-character commit sha**.

**Nothing is fetched from the network unless an administrator has registered a source**, and two
things have to be true before one can be. The repository must be named in `OPENBOT_TEMPLATE_SOURCES`,
a comma-separated allowlist that **ships empty** and that the screen renders but cannot widen — the
`INITIAL_ADMIN_EMAILS` shape, where the deployment's configuration decides and the product shows the
decision. And the registration must carry a commit, not a branch or a tag: `main` is a name whoever
owns that repository can repoint after an administrator has read the files, which is exactly the
mechanism behind the supply-chain compromises this format has no version of. Handles are lowercased
by the same function on both sides, so the allowlist cannot be evaded by capitalising a letter.

The reason for the allowlist is that a self-hosted product which reaches a third party on first boot
because its vendor shipped a default has made that decision on its operator's behalf. This one does
not.

Fetching is server-side, always, from `raw.githubusercontent.com` at the pinned sha. A gallery
rendered from the browser would give everybody looking at it a third-party origin they did not
choose, and would show the source each viewer's address.

`raw.githubusercontent.com` serves one file at a time and cannot list a directory, so a source says
what it holds in a manifest at `openbot-templates.json`, an object with a `templates` array of paths.
A source that publishes no manifest holds nothing, rather than this deployment falling back to
something looser. The caps are numbers this deployment chose rather than ones the source did: 200
files, 4 MiB across a listing, 64 KiB of manifest and 200 characters of path. A breached cap or a
manifest that is not one refuses the whole listing, because a manifest read only as far as the cap
would drop files silently and let the source decide which survived. A single file that cannot be
fetched, names a path that is not a plain relative path to a YAML file inside the repository, or does
not parse is skipped and named, exactly as in the directory.

A listing is cached under `owner/repo@sha`. That is sound precisely because a sha names one immutable
tree: moving the pin produces a different key rather than an invalidation somebody has to remember to
perform, and it is the only way the contents a deployment sees ever change.

### Who may install

`OPENBOT_TEMPLATE_INSTALLERS` is `anyone` or `admin`, and `anyone` is the default. Everything an
install writes — the Bot, its skills, and the grants that pair the two — is what `POST /api/agents`,
`POST /api/plugins/skills` and `POST /api/plugins/grants` already permit the same person one act at a
time. There is no fourth call, so requiring an administrator would be a ceremony around acts that
person can already perform.

A deployment that wants the ceremony anyway sets the variable, and what it sets is a **floor**: the
screen may raise the setting to `admin` and may never lower it back. An operator who wrote
`OPENBOT_TEMPLATE_INSTALLERS=admin` into their configuration has to be able to rely on it holding,
and a restriction any administrator can click away is one that will be clicked away by whoever finds
it inconvenient. Where the floor is in force the control is rendered disabled, saying where it came
from, as an administrator named in `INITIAL_ADMIN_EMAILS` is.

### The gallery, and installing out of it

The gallery is the directory first and then each registered source in turn, with a slug going to
whoever offered it first and every later claim listed as skipped beside the name of what already
holds it. A source that cannot be read at all — a refusal, a timeout, a proxy answering with
something that is not a response — is reported the same way rather than emptying the screen: a
deployment's own in-box templates do not vanish because a third party is having a bad morning.

Installing from the gallery posts a slug and the digest that was shown, and **the document comes
back out of the catalogue on the server** rather than off the wire. Trusting a posted document would
make "this came from the gallery" a thing anybody could write into the provenance row that an
administrator later reads when deciding whether a coworker came from somewhere this deployment
vouches for. The digest still has to match, so a source that moved between the consent screen and
the button is a 409 exactly as an edited paste is.

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /api/templates/gallery` | Signed in | What this deployment offers, and what it could not read. |
| `GET /api/templates/gallery/:slug` | Signed in | One entry, as the document it is and the file it came from. |
| `GET /api/admin/templates/settings` | Administrator | Who may install, the floor beneath that, the repositories the environment permits, and the ones registered. |
| `PUT /api/admin/templates/settings` | Administrator | Raise who may install. A refusal names what is still in force. |
| `POST /api/admin/templates/sources` | Administrator | Pin a repository the gallery may read from. |
| `DELETE /api/admin/templates/sources` | Administrator | Forget one. |
| `GET /api/admin/templates/imports` | Administrator | What this deployment has imported. |

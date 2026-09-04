# Netsfera document agents on OpenBot v0.0.7

## Goal

Upgrade the Netsfera OpenBot customization to the v0.0.7 product base and make the existing
`jefe-erp` and `recolector-documentos` agents useful without introducing a new provider subsystem.
The collector will learn one browser procedure per provider as an ordinary OpenBot skill, with a
person handling authentication and approving both the skill and every document collection.

The procedures are written around a logical download step so they remain valid when OpenBot gains a
governed binary-download capability. Until that capability exists, the same step opens the approved
document and hands control to the person for the final save.

## Scope

This design includes:

- rebasing the existing Netsfera tenant and computer-access extension onto OpenBot v0.0.7;
- refining the two existing agents without changing their ids or channels;
- giving only the document collector a browser;
- adding OpenBot's shipped conversational `skill-creator` to the collector;
- adding a deployment skill for teaching the collector a new provider;
- creating one personal skill per provider through the normal OpenBot confirmation card;
- requiring explicit human selection or approval before the download stage;
- defining the future governed-download contract so provider skills do not need to be rewritten.

This design does not include:

- an ERP MCP server or new ERP write operations;
- unattended browser routines;
- automatic changes to the action policy when a provider is added;
- implementation of binary download, storage, or export;
- credentials, selectors, cookies, or one-time codes inside a skill;
- a new database entity or administration screen for providers.

## Existing deployment

The `bot` host currently runs commit `ff5aa7ebd8ac798887017bfa1f5a471483b0c499` using the
`netsfera-openbot.service` unit and `/usr/local/lib/netsfera/openbot-compose-v1.sh`. The deployment is
healthy and its source tree is clean. It contains a Netsfera overlay and a custom per-agent
`computerAccess` gate that are not present in upstream OpenBot v0.0.7.

Both target agents already exist in `examples/netsfera/agents.yaml` and have durable channels:

- `jefe-erp` in `control-erp`;
- `recolector-documentos` in `documentos-externos`.

Both currently have `computer_access: disabled`, no skills, and G0 prompts that explicitly refuse all
external work. Reusing these ids preserves existing channels, preferences, audit references, and
conversation history. Creating duplicate agents would provide no benefit.

## Architecture

### Jefe ERP

`jefe-erp` remains the coordinator. It does not receive a browser in this phase. Its responsibilities
are to understand the request, answer only from ERP tools it has actually been granted, and hand
external-document work to `recolector-documentos` through OpenBot's native directional handoff.

The agent must never claim that a handoff, ERP lookup, provider visit, or download occurred unless a
tool result says it did. If the collector is unavailable or the handoff is refused, it reports that
fact and leaves the request pending for the person.

Keeping the browser out of the coordinator reduces tool choice, separates ERP data access from
internet browsing, and leaves one audit identity for all provider activity.

### Recolector de documentos

`recolector-documentos` is the only browser-enabled agent. It remains a built-in, private specialist
and receives:

- `computer_access: enabled`;
- the shipped `skill-creator` deployment skill;
- a Netsfera deployment skill named `crear-proveedor-documental`;
- access to the published `askChoice` and `askApproval` components;
- its own supervised computer, Chromium profile, and workspace;
- no shell or arbitrary file-write capability.

Its role is to browse approved provider portals, request human control for login, enumerate candidate
documents, obtain confirmation, and perform the logical download step. It does not make purchases,
change subscriptions, alter payment methods, create credentials, or submit unrelated forms.

### Why a provider is a skill

A provider is a browser procedure, not a capability grant. OpenBot v0.0.7 skills already provide the
required representation: slug, title, summary, instructions, and optional MCP tool declarations.
Using one skill per provider gives the procedure a visible `/` command, human ownership, replacement
semantics, conversational review, and explicit assignment to a Bot.

Provider access remains outside the skill. The computer gate decides whether the agent has a browser,
and the action policy decides which sites and actions it may reach. A skill cannot widen either one.

## Skills

### `skill-creator`

Use OpenBot v0.0.7's shipped skill without forking it. It makes `list_skills`, `read_skill`,
`list_skill_tools`, and the human-confirmed `save_skill` card available in an interactive browser
conversation. Its built-in rehearsal is the pre-save review mechanism.

A saved personal skill starts on no Bot. The person follows the card's `Put it on a Bot` link and
assigns it to `recolector-documentos`. This explicit second confirmation is retained.

### `crear-proveedor-documental`

This deployment skill specializes the native authoring flow for provider portals. It instructs the
collector to:

1. Ask for the provider name, official portal URL, document type, expected identifying fields, and
   the rule for deciding which documents are candidates.
2. Verify that the provider's required hosts are already permitted. If not, stop and name the hosts
   an administrator must review and add; never attempt an alternate host to evade the boundary.
3. Navigate itself while the person gives directions in chat. Use human takeover only for login,
   password, 2FA, CAPTCHA, consent, or a step the agent cannot safely perform.
4. After control is returned, snapshot the current page and ask what the human-only step achieved
   when the resulting state is ambiguous.
5. Record stable semantic instructions such as labels, headings, URLs, and validation checks. Never
   record ephemeral snapshot refs, screen coordinates, cookies, credentials, or one-time codes.
6. Include empty-state, expired-session, changed-page, duplicate-document, and partial-failure
   behavior in the provider skill.
7. Rehearse one realistic request before proposing the skill.
8. Call `save_skill` only after the person agrees with the draft.

### Provider skill contract

Each generated provider skill must contain these phases in this order:

1. Open the canonical provider portal.
2. Detect whether the authenticated account and expected organization are correct.
3. Request takeover for login, 2FA, CAPTCHA, account switching, or sensitive confirmation.
4. Navigate to the document area using semantic page structure.
5. Enumerate candidates without downloading them.
6. Return a selection table containing provider, document identifier, issue date, period, amount and
   currency when present, file type, and source link or page.
7. Ask the person to choose documents or approve the complete set.
8. Download only the approved documents through the governed download capability available to the
   agent.
9. Validate each result and report saved, skipped, duplicate, and failed documents separately.

If no governed binary-download capability is available at step 8, the agent opens each approved
document, asks the person to take control and save it, then records the result as `human_save_required`
rather than claiming it downloaded the file.

## Guided provider-creation flow

The person invokes `/crear-proveedor-documental` in a conversation with the collector. The collector
interviews them and drives the browser while the person narrates the procedure. This matters because
OpenBot records the agent's computer tool calls but does not transform a person's takeover clicks
into a reusable workflow.

The transcript and current page state provide the evidence for the draft. Authentication remains
outside the transcript. Once the procedure is complete, the collector presents the provider skill in
the native save card. A declined card returns to editing; an accepted card creates the personal skill.
The person then assigns it to the collector from `/skills` and tests it in a fresh conversation.

Updating a provider repeats the same flow: `list_skills`, `read_skill`, guided execution, rehearsal,
and replacement card. The existing slug is reused only when the skill belongs to the current author.

## Runtime document flow

When a provider skill is invoked, the collector opens its persistent browser profile. Existing
persistent cookies and local storage are reused, but the design assumes a provider may expire them at
any time. Login state is checked instead of presumed.

The agent gathers metadata first and performs no download during discovery. It uses `askChoice` when
individual selection is useful and `askApproval` for an all-or-nothing set. Rejection ends the run
without downloading. Approval freezes the selected document identifiers for that run so a refreshed
page cannot silently change the set.

The collector processes the approved set one document at a time and reports an outcome per document.
A failure does not cause an unapproved substitute to be downloaded. If the page changes materially,
the agent stops and asks to update the provider skill.

## Browser and policy boundaries

The Netsfera `computerAccess` extension remains the capability gate and must be rebased onto v0.0.7.
It keeps computer tools out of agents that are disabled. `jefe-erp` remains disabled;
`recolector-documentos` becomes enabled.

The global CEL action policy remains a second, independent boundary. Its current unconditional deny
for every `computer_*` action by the collector must be replaced, not merely supplemented, because
deny rules take precedence over allow rules. The resulting policy must:

- retain the complete computer deny for `jefe-erp`;
- allow the collector's navigate, read, snapshot, click, type, key, scroll, and help/control flow only
  on reviewed provider and authentication hosts;
- deny shell and arbitrary file writes for the collector;
- deny purchasing, upgrades, payment-method changes, password changes, membership administration,
  and credential or API-key creation;
- permit file listing and reading only inside the dedicated downloads area when such files exist;
- start in dry-run for newly added restrictions, review recorded matches, and then switch to enforce.

Adding a provider therefore has one administrator step before teaching it: review and add the exact
portal and authentication hosts. Skill creation never edits the policy.

## Logical download and future native tool

Provider skills refer to a governed download capability rather than browser implementation details.
The current adapter is the human-save fallback. A future OpenBot issue or implementation should add a
single acting tool, tentatively `computer_download`, with this behavior:

- consume a current snapshot id and a downloadable element ref or an explicitly approved URL;
- require a workspace-relative destination beneath `downloads/`;
- capture the Playwright download event and wait for completion;
- return the final relative path, original filename, MIME type, byte length, SHA-256 digest, and source
  URL;
- reject path traversal, unsupported schemes, stale refs, unapproved redirects, and files exceeding a
  configured limit;
- evaluate action policy with both page and destination-file context before starting;
- audit the decision and final outcome without recording file contents or credentials;
- make the resulting file available through an authenticated export path.

When that tool is available and granted, existing provider skills naturally use it at their download
phase. Their discovery, approval, authentication, validation, and reporting instructions do not
change.

## Failure handling

- **Authentication required:** request takeover; never ask for a password in chat.
- **Session expired mid-run:** stop before further documents and request takeover again.
- **CAPTCHA or anti-automation refusal:** request takeover; if the portal still refuses the browser,
  report the provider as unsupported rather than attempting evasion.
- **Host refused:** report the exact host and matching boundary rule; require administrator review.
- **No documents:** return a successful empty result with the period and filters checked.
- **Unexpected layout:** stop before activation or download, capture the observable mismatch, and
  propose updating the provider skill.
- **Partial download failure:** preserve successful outcomes, report each failure, and do not retry an
  action that could duplicate a document without asking.
- **Missing native download:** use the human-save fallback and label it accurately.
- **Handoff failure:** Jefe ERP reports that the collector did not accept or complete the request.

## Verification

Before deployment, automated verification must cover:

- loading the Netsfera tenant package on the v0.0.7 schema;
- preservation of the two agent ids and channel assignments;
- browser tools absent for `jefe-erp` and present for `recolector-documentos`;
- `skill-creator` and `crear-proveedor-documental` granted only as designed;
- existing computer-access, stream-access, and fail-closed tests;
- CEL policy evaluation for allowed provider navigation, forbidden hosts, sensitive actions, shell,
  and downloads-directory file access;
- startup and migration tests for the complete Compose overlay set.

The deployment journey must then verify:

1. both agents open in their existing channels;
2. Jefe ERP cannot browse and can hand a document request to the collector;
3. the collector can navigate to one reviewed provider;
4. takeover and return work for login;
5. `/crear-proveedor-documental` produces a reviewed skill card;
6. the saved skill can be assigned to the collector;
7. the provider skill lists documents before asking for approval;
8. rejection performs no download action;
9. approval reaches the human-save fallback and never claims a native download;
10. Audit identifies the agent, actor, host, decision, and matching rule.

Production rollout must follow `/usr/local/lib/netsfera/openbot-compose-v1.sh`, use an immutable commit,
take a database and source backup, and verify the approved external route before and after restart.

## Success criteria

The first release is complete when the existing collector can be taught a reviewed provider flow in
conversation, save and receive the resulting skill, reuse an authenticated browser session when the
provider permits it, enumerate documents, obtain explicit approval, and reach a truthful human-save
fallback. The Jefe ERP must remain unable to browse and must delegate external-document work to the
collector.

The later download enhancement is complete when the same provider skills save approved binary files
through the governed tool and return verifiable file metadata without changing their instructions.

# Netsfera Document Agents on OpenBot v0.0.7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Netsfera deployment to OpenBot v0.0.7 and make the existing document collector browser-enabled, able to create provider skills conversationally, and able to receive work from Jefe ERP without adding an ERP MCP or native binary download.

**Architecture:** Merge the exact deployed Netsfera safety delta onto upstream v0.0.7, retaining the per-agent `computerAccess` entitlement in front of OpenBot's global CEL policy. Package the two existing agents and two deployment skills deterministically, activate only the collector's browser, and reuse the host's reviewed-image/manifest deployment boundary so the configuration survives service restarts. Provider skills describe a logical download phase and truthfully fall back to `human_save_required` until a governed binary-download tool exists.

**Tech Stack:** Bun 1.3.14, TypeScript, React, Hono, Drizzle/PostgreSQL, YAML tenant packages, CEL action policy, Docker Compose, systemd, Bash, Playwright-backed OpenBot computers.

**Spec:** `docs/superpowers/specs/2026-09-04-netsfera-document-agents-design.md`

## Global Constraints

- The product base is the immutable upstream commit `9aedb575161a1de0b2e8545f436f90ff7e186d99` (`v0.0.7`).
- The deployed Netsfera baseline is `ff5aa7ebd8ac798887017bfa1f5a471483b0c499`, available locally as `refs/remotes/bot/deployed`.
- The unactivated reviewed G1 reference is `f048e4cd1a70cde93ad87c02fbf4be58971301f2`, available locally as `refs/remotes/bot/g1-staged`; reuse only its deployment-lock and persistent-activation machinery, not its ERP MCP capability.
- Preserve agent ids `jefe-erp` and `recolector-documentos` and channel ids `control-erp` and `documentos-externos`.
- `jefe-erp` remains `computer_access: disabled`; only `recolector-documentos` becomes `computer_access: enabled`.
- Do not add an ERP MCP, automated browser routine, provider database entity, credential to a skill, or binary-download implementation.
- Skills never grant capabilities. Browser entitlement and CEL policy remain independent, fail-closed boundaries.
- Do not claim a file was downloaded unless a supported tool returns a saved-file result; use `human_save_required` in this release.
- Do not read, print, copy, or commit `/opt/openbot/.env`, phase-two secret material, activation attestations, or credential values.
- All production Compose operations use `/usr/local/lib/netsfera/openbot-compose-v1.sh`; never use `/opt/openbot/activate.sh` or bare base-only Compose.
- A production change requires an immutable commit, a maintenance window, a database/source backup, and an identified rollback owner.

## File map

- `server/src/computer/access.ts`: normalize the durable per-agent computer entitlement.
- `server/src/computer/stream-access.ts`: apply entitlement to websocket/live-screen lookup.
- `server/src/agents/profile-types.ts`: expose `computerAccess` on the profile DTO.
- `server/src/agents/profile-store.ts`: preserve v0.0.7 built-in-agent semantics while defaulting newly created/duplicated agents to disabled.
- `server/src/tenant-package.ts`: validate `computer_access` and persist an explicit package entitlement.
- `server/src/app.ts`, `server/src/computer/routes.ts`: enforce entitlement on every computer route.
- `app/src/lib/computers/access.ts`, `app/src/lib/copilot/computer-tools.tsx`: hide computer tools until the active Bot is confirmed enabled.
- `supervisor/src/dns.ts`, `supervisor/src/extra-hosts.ts`, `supervisor/src/docker.ts`, `supervisor/src/index.ts`: preserve validated computer DNS/static-host configuration already used by Netsfera.
- `examples/netsfera/agents.yaml`: define the two durable roles, prompts, entitlements, and deployment-skill assignments.
- `examples/netsfera/skills.yaml`: ship unmodified `skill-creator` plus the Netsfera `crear-proveedor-documental` flow.
- `deploy/netsfera/agent-computer-policy.json`: reviewed executable browser/file policy.
- `deploy/netsfera/docker-compose.erp-agent.yml`: persist the Netsfera tenant path and reviewed policy in the active stack.
- `deploy/netsfera/stage-reviewed-g1.sh`, `deploy/netsfera/verify-staged-g1.sh`, wrappers and lock scripts: retain exact-image staging and restart-persistent activation while changing the accepted contract from ERP G1 to document agents.
- `server/tests/netsfera-document-agents.test.ts`: pin agent and skill semantics.
- Existing computer-access, overlay, supervisor, staging, wrapper, and promotion tests: pin the inherited safety boundary.
- `docs/runbooks/netsfera-document-agents-v007.md`: operator commands, evidence, rollback boundary, and post-deploy journey.

---

### Task 1: Merge the deployed Netsfera safety foundation onto v0.0.7

**Files:**
- Merge source: `refs/remotes/bot/deployed`
- Modify: `server/src/agents/profile-store.ts`
- Verify: all files introduced or modified by `v0.0.5..refs/remotes/bot/deployed`

**Interfaces:**
- Consumes: upstream v0.0.7 agent profile and computer gateway APIs.
- Produces: the existing `ComputerAccess = "enabled" | "disabled"` boundary, validated supervisor host configuration, Netsfera package files, and reviewed-overlay tooling on the v0.0.7 tree.

- [ ] **Step 1: Create the isolated execution worktree and prove the three immutable refs**

Run:

```bash
git rev-parse v0.0.7 refs/remotes/bot/deployed refs/remotes/bot/g1-staged
git merge-base v0.0.7 refs/remotes/bot/deployed
```

Expected commits, in order: `9aedb575161a1de0b2e8545f436f90ff7e186d99`, `ff5aa7ebd8ac798887017bfa1f5a471483b0c499`, `f048e4cd1a70cde93ad87c02fbf4be58971301f2`; merge base `0bb2f634bd5e5141c421aefa56620b60fb5e4e94`.

- [ ] **Step 2: Merge the deployed history without committing**

Run:

```bash
git merge --no-commit --no-ff refs/remotes/bot/deployed
git diff --name-only --diff-filter=U
```

Expected: the only content conflict is `server/src/agents/profile-store.ts`. If another path conflicts, stop; the refs or base differ from the reviewed graph.

- [ ] **Step 3: Resolve `profile-store.ts` by retaining both v0.0.7 behavior and the entitlement**

Use `apply_patch` to retain v0.0.7's `systemPromptOf`, `runForDuplicate`, built-in creation, and built-in role-description update. Add these exact entitlement hooks:

```ts
import { computerAccessOf } from "../computer/access";

// In mapProfile's return value:
computerAccess: computerAccessOf(row.configuration),

export function newProfileConfiguration(
  configuration: Record<string, unknown>,
) {
  return { ...configuration, computerAccess: "disabled" as const };
}
```

Wrap all newly born configurations, without changing updates of existing rows:

```ts
configuration: newProfileConfiguration({
  ...endpoint,
  ...(input.auth && vault
    ? {
        auth: await storeAgentAuth({
          store: vault.store,
          encryptionKey: vault.encryptionKey,
          agentId: id,
          header: input.auth.header,
          value: input.auth.value,
          executor: transaction,
        }),
      }
    : {}),
})
configuration: newProfileConfiguration({ systemPrompt })
configuration: newProfileConfiguration(run.configuration)
```

The update path must spread the existing configuration first so an existing explicit `computerAccess` value survives a profile edit.

- [ ] **Step 4: Confirm the merge did not discard v0.0.7 browser and authoring features**

Run:

```bash
git diff --check
rg -n 'computer_request_help|follows-popup|skill-creator|save_skill' app agent-computer examples/fintech
rg -n 'computerAccess|canUseComputer|locateComputerStream' app/src server/src
```

Expected: both sets of symbols are present; no conflict markers or whitespace errors.

- [ ] **Step 5: Install dependencies and run the inherited safety tests**

Run:

```bash
bun install --frozen-lockfile
bun test \
  server/tests/computer-access.test.ts \
  server/tests/computer-stream-access.test.ts \
  server/tests/new-profile-computer-access.test.ts \
  server/tests/tenant-package.test.ts \
  app/tests/computer-access.test.ts \
  supervisor/tests/dns.test.ts \
  supervisor/tests/extra-hosts.test.ts \
  supervisor/tests/docker-host-config.test.ts
bun run typecheck
```

Expected: all named tests and all workspace typechecks pass.

- [ ] **Step 6: Commit the v0.0.7 safety port**

```bash
git add Dockerfile app deploy docs examples scripts server supervisor
git commit -m "feat: port Netsfera computer controls to OpenBot v0.0.7"
```

---

### Task 2: Define the two agents and the provider-authoring skills

**Files:**
- Create: `examples/netsfera/skills.yaml`
- Create: `server/tests/netsfera-document-agents.test.ts`
- Modify: `examples/netsfera/agents.yaml`

**Interfaces:**
- Consumes: v0.0.7 tenant `skills.yaml`, the shipped app-owned skill-authoring tools, and `computer_access` from Task 1.
- Produces: package grants for `skill-creator` and `crear-proveedor-documental` on the collector, plus prompts that implement truthful handoff, discovery, approval, and download fallback.

- [ ] **Step 1: Write the failing package-contract test**

Create `server/tests/netsfera-document-agents.test.ts` with these assertions:

```ts
import { describe, expect, test } from "bun:test";
import { loadTenantPackage } from "../src/tenant-package";

describe("the Netsfera document agents", () => {
  test("keeps Jefe ERP computerless and enables only the collector", async () => {
    const tenant = await loadTenantPackage(
      new URL("../../examples/netsfera", import.meta.url).pathname,
    );
    const chief = tenant.agents.find((agent) => agent.id === "jefe-erp");
    const collector = tenant.agents.find(
      (agent) => agent.id === "recolector-documentos",
    );

    expect(chief?.configuration).toMatchObject({ computerAccess: "disabled" });
    expect(chief?.skills).toEqual([]);
    expect(collector?.configuration).toMatchObject({ computerAccess: "enabled" });
    expect(collector?.skills).toEqual([
      "skill-creator",
      "crear-proveedor-documental",
    ]);
  });

  test("ships a provider flow with confirmation and a truthful fallback", async () => {
    const tenant = await loadTenantPackage(
      new URL("../../examples/netsfera", import.meta.url).pathname,
    );
    const creator = tenant.skills.find((skill) => skill.slug === "skill-creator");
    const provider = tenant.skills.find(
      (skill) => skill.slug === "crear-proveedor-documental",
    );

    expect(creator?.instructions).toContain("save_skill");
    expect(creator?.tools).toEqual([]);
    expect(provider?.instructions).toContain("askChoice");
    expect(provider?.instructions).toContain("askApproval");
    expect(provider?.instructions).toContain("human_save_required");
    expect(provider?.instructions).toContain("Never record");
    expect(provider?.tools).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test server/tests/netsfera-document-agents.test.ts`

Expected: FAIL because `skills.yaml` is absent and the collector is disabled.

- [ ] **Step 3: Update the exact agent definitions**

Use `apply_patch` so `examples/netsfera/agents.yaml` retains the two existing ids and channels and contains these effective fields:

```yaml
agents:
  - id: jefe-erp
    name: Jefe ERP
    title: Control ERP
    role_description: Coordina el trabajo del ERP y delega la recopilacion de documentos externos.
    avatar_seed: jefe-erp
    type: built-in
    computer_access: disabled
    system_prompt: >-
      You are the NETSFERA ERP chief. Answer only from capabilities and results actually offered to
      this run. You have no browser. When a request requires an external provider portal, hand the
      concrete task to Recolector de documentos if the handoff tool offers it. Never claim that an
      ERP lookup, handoff, provider visit, or download happened unless a tool result says it did. If
      no suitable capability is available, say exactly what is missing.
  - id: recolector-documentos
    name: Recolector de documentos
    title: Documentos externos
    role_description: Aprende y ejecuta procedimientos revisados para recopilar documentos externos.
    avatar_seed: recolector-documentos
    type: built-in
    computer_access: enabled
    system_prompt: >-
      You are the NETSFERA document collector. Browse only through the computer tools and only on
      hosts allowed by the deployment. Ask the person to take control for login, passwords, 2FA,
      CAPTCHA, consent, account switching, or any sensitive confirmation. Discover and list candidate
      documents before asking the person to select or approve them. Act only on the approved set.
      Never purchase, upgrade, change payment methods, administer members, create credentials, or
      claim a file was downloaded without a saved-file tool result. When native download is not
      available, open the approved document, request human control, and report human_save_required.
    skills:
      - skill-creator
      - crear-proveedor-documental
```

- [ ] **Step 4: Add the two deployment skills**

Use `apply_patch` to create `examples/netsfera/skills.yaml`.

- Copy the complete `skill-creator` entry verbatim from the `- slug: skill-creator` block in `examples/fintech/skills.yaml`; do not fork or shorten its instructions and leave `tools` absent/empty.
- Add this exact second entry, with no `tools` field:

```yaml
  - slug: crear-proveedor-documental
    title: Crear un proveedor documental
    summary: Aprende conmigo un portal y propone una skill revisable para recopilar sus documentos.
    instructions: |-
      Create or improve one provider-specific document collection skill. Work interactively and do
      not save anything until the person has reviewed it.

      First ask for the provider name, its official portal URL, the document type, the fields that
      identify a document, and the rule that decides which documents are candidates. Ask no more
      than three questions at once and infer what the person has already made clear.

      Check that every portal and authentication host is allowed before teaching the procedure. If
      a host is refused, stop and name it for administrator review. Never try an alternate host to
      bypass the boundary.

      Drive the browser yourself while the person narrates the next meaningful step. Request human
      control for login, password, 2FA, CAPTCHA, consent, account switching, or a sensitive action.
      After control returns, take a fresh snapshot and ask what changed if the resulting state is
      ambiguous.

      Record stable URLs, headings, labels, visible states, filters, and validation checks. Never record
      snapshot refs, screen coordinates, cookies, passwords, credentials, secrets, or one-time codes.
      Define what to do when there are no documents, the session expires, the layout changes, a
      document is a duplicate, or only part of the selected set succeeds.

      Draft a provider skill whose runtime phases are: verify the account; reach the document area;
      enumerate candidates without downloading; show provider, document identifier, issue date,
      period, amount, currency, file type, and source whenever present; call askChoice for individual
      selection or askApproval for the whole set; act only on the approved identifiers; perform the
      logical download step; and report saved, skipped, duplicate, and failed documents separately.

      A download is successful only when a governed capability returns a saved-file result. If none
      is available, open each approved document, request human control for the final save, and report
      human_save_required. Never claim that the file was downloaded in that case.

      Rehearse one realistic request step by step. Fix ambiguities found by the rehearsal, show the
      final draft in the conversation, and call save_skill once only after the person agrees. Explain
      that the saved skill must then be put on Recolector de documentos from the Skills page.
```

The provider skill generated by this flow must require the result columns `provider`, `document identifier`, `issue date`, `period`, `amount`, `currency`, `file type`, and `source` whenever the portal exposes them.

- [ ] **Step 5: Run the package tests**

Run:

```bash
bun test server/tests/netsfera-document-agents.test.ts server/tests/tenant-package.test.ts app/tests/skill-creator-slug.test.ts app/tests/skill-proposal.test.ts app/tests/proposed-skill-card.test.tsx
```

Expected: PASS; the skill creator remains exactly load-bearing and no skill declares a nonexistent browser/MCP tool.

- [ ] **Step 6: Commit the agent package**

```bash
git add examples/netsfera/agents.yaml examples/netsfera/skills.yaml server/tests/netsfera-document-agents.test.ts
git commit -m "feat: configure Netsfera document agents and provider authoring"
```

---

### Task 3: Activate the collector's reviewed browser policy

**Files:**
- Modify: `deploy/netsfera/agent-computer-policy.json`
- Modify: `deploy/netsfera/docker-compose.erp-agent.yml`
- Modify: `server/tests/netsfera-overlay.test.ts`
- Modify: `server/tests/computer-policy.test.ts`

**Interfaces:**
- Consumes: `PolicyContext` with `bot.id`, `tool.name`, `intent`, `page`, `element`, and `file`.
- Produces: an enforce-mode policy that allows only reviewed collector activity and keeps Jefe ERP completely computerless.

- [ ] **Step 1: Replace the G0 assertions with failing browser-policy assertions**

In `server/tests/netsfera-overlay.test.ts`, retain the rendered-overlay equivalence and topology tests. Add this helper beside the existing `context()` helper, then replace the test that denies every collector tool with table tests asserting:

```ts
function decide(botId: string, toolName: string, host: string) {
  const policy = renderedOverlayPolicy();
  return evaluateActionPolicy(
    policy,
    context({
      bot: { id: botId },
      tool: { name: toolName },
      intent:
        toolName === "computer_navigate"
          ? "navigate"
          : toolName === "computer_write_file"
            ? "write_file"
            : toolName === "computer_run_command"
              ? "run_command"
              : "read",
      page: {
        host,
        url: host ? `https://${host}/` : "",
      },
    }),
  );
}

expect(decide("jefe-erp", "computer_navigate", "chatgpt.com").allowed).toBe(false);
expect(decide("recolector-documentos", "computer_navigate", "chatgpt.com").allowed).toBe(true);
expect(decide("recolector-documentos", "computer_navigate", "evil.example").allowed).toBe(false);
expect(decide("recolector-documentos", "computer_run_command", "").allowed).toBe(false);
expect(decide("recolector-documentos", "computer_write_file", "").allowed).toBe(false);
```

Add explicit contexts proving that a purchase/upgrade/payment/API-key/password element is denied and that `computer_list_files`/`computer_read_file` are allowed only for `downloads/`.

- [ ] **Step 2: Run the policy tests to verify the collector is still denied**

Run: `bun test server/tests/netsfera-overlay.test.ts server/tests/computer-policy.test.ts`

Expected: FAIL on the approved-host collector case because the current first collector deny matches every `computer_*` action.

- [ ] **Step 3: Write the reviewed policy artifact**

Use `apply_patch` to remove only this obsolete rule:

```text
bot.id == "recolector-documentos" && matches(tool.name, "^computer_")
```

Retain the complete `jefe-erp` deny, the collector shell/file-write deny, the forbidden-host deny, and the sensitive URL/element denies. Retain these two allow expressions with the current reviewed initial hosts:

```text
bot.id == "recolector-documentos" && tool.name in ["computer_navigate","computer_click","computer_type","computer_key","computer_scroll"] && page.host in ["chatgpt.com","auth.openai.com","platform.openai.com","accounts.hetzner.com","console.hetzner.cloud"]
bot.id == "recolector-documentos" && tool.name in ["computer_read_file","computer_list_files"] && matches(file.path, "^downloads(/|$)")
```

Keep `mode` as `enforce`. Page reads, snapshots, screenshots, help requests, and human control are non-acting routes; they are protected by `computerAccess` and do not need CEL allow entries.

- [ ] **Step 4: Make the Compose policy byte-equivalent to the artifact**

Update only `services.openbot.environment.AGENT_COMPUTER_POLICY` in `deploy/netsfera/docker-compose.erp-agent.yml` so its decoded JSON equals `agent-computer-policy.json`. Do not add ports, networks, volumes, privileges, or services.

- [ ] **Step 5: Run policy and overlay verification**

Run:

```bash
bun test server/tests/netsfera-overlay.test.ts server/tests/computer-policy.test.ts
bun test server/tests/verify-rendered-overlay-script.test.ts
```

Expected: PASS, including exact JSON equivalence and unchanged hardened topology.

- [ ] **Step 6: Commit the browser policy**

```bash
git add deploy/netsfera/agent-computer-policy.json deploy/netsfera/docker-compose.erp-agent.yml server/tests/netsfera-overlay.test.ts server/tests/computer-policy.test.ts
git commit -m "feat: enable governed browsing for the document collector"
```

---

### Task 4: Port restart-persistent reviewed activation without the ERP MCP

**Files:**
- Port from `refs/remotes/bot/g1-staged`: `deploy/netsfera/install-openbot-lock-contract.sh`
- Port from `refs/remotes/bot/g1-staged`: `deploy/netsfera/manage-openbot-g1-activation-v1.sh`
- Port from `refs/remotes/bot/g1-staged`: `deploy/netsfera/netsfera-openbot-deployment-lock.conf`
- Port from `refs/remotes/bot/g1-staged`: `deploy/netsfera/openbot-compose-lock-v1.sh`
- Port from `refs/remotes/bot/g1-staged`: `deploy/netsfera/recover-openbot-g0-baseline-v1.sh`
- Port from `refs/remotes/bot/g1-staged`: `deploy/netsfera/rollback-openbot-lock-contract-v1.sh`
- Port and modify: `deploy/netsfera/stage-reviewed-g1.sh`
- Port from `refs/remotes/bot/g1-staged`: `deploy/netsfera/verify-openbot-lock-contract-v1.sh`
- Port and modify: `deploy/netsfera/verify-staged-g1.sh`
- Port wrappers: `deploy/netsfera/verify-reviewed-g0-recovery-wrapper.sh`, `verify-reviewed-g1-stage-wrapper.sh`, `verify-reviewed-host-lock-wrapper.sh`
- Port tests: `server/tests/openbot-host-lock-contract.test.ts`, `recover-openbot-g0-baseline.test.ts`, `reviewed-g1-stage-script.test.ts`, `docker-descriptor-format.test.ts`
- Modify: `deploy/netsfera/promote-reviewed-g0.sh`
- Modify: `server/tests/reviewed-promotion-script.test.ts`

**Interfaces:**
- Consumes: the host's existing `/usr/local/lib/netsfera/openbot-compose-v1.sh`, deployment lock, inactive activation-manifest contract, and current G0 baseline.
- Produces: a staged exact-image candidate and an 11-field activation manifest that makes the Netsfera overlay and exact image survive every later service invocation/restart.

- [ ] **Step 1: Port only the deployment-boundary files from the reviewed G1 ref**

In the isolated execution worktree, restore only these explicit paths from the immutable reviewed ref:

```bash
git restore --source=refs/remotes/bot/g1-staged -- \
  deploy/netsfera/install-openbot-lock-contract.sh \
  deploy/netsfera/manage-openbot-g1-activation-v1.sh \
  deploy/netsfera/netsfera-openbot-deployment-lock.conf \
  deploy/netsfera/openbot-compose-lock-v1.sh \
  deploy/netsfera/recover-openbot-g0-baseline-v1.sh \
  deploy/netsfera/rollback-openbot-lock-contract-v1.sh \
  deploy/netsfera/stage-reviewed-g1.sh \
  deploy/netsfera/verify-openbot-lock-contract-v1.sh \
  deploy/netsfera/verify-reviewed-g0-recovery-wrapper.sh \
  deploy/netsfera/verify-reviewed-g1-stage-wrapper.sh \
  deploy/netsfera/verify-reviewed-host-lock-wrapper.sh \
  deploy/netsfera/verify-staged-g1.sh \
  server/tests/openbot-host-lock-contract.test.ts \
  server/tests/recover-openbot-g0-baseline.test.ts \
  server/tests/reviewed-g1-stage-script.test.ts \
  server/tests/docker-descriptor-format.test.ts
```

Do not port:

```text
server/scripts/bootstrap-netsfera-agent.ts
server/scripts/store-netsfera-erp-token.ts
server/scripts/rollback-netsfera-agent.ts
server/tests/netsfera-erp-mcp-contract.integration.test.ts
server/tests/netsfera-package-g1.test.ts
examples/netsfera/skills.yaml from refs/remotes/bot/g1-staged
```

Those files implement the deferred ERP MCP and would conflict with Task 2's package.

- [ ] **Step 2: Write the new stage acceptance assertions first**

Adapt `server/tests/reviewed-g1-stage-script.test.ts` so the staged candidate must prove:

```text
source commit equals the requested 40-hex commit
source tree is clean
candidate image has an exact index id, platform config id, and descriptor digest
functional overlay hash equals the candidate commit's deploy/netsfera/docker-compose.erp-agent.yml blob
rendered tenant package is ../examples/netsfera
rendered AGENT_COMPUTER_POLICY equals agent-computer-policy.json
jefe-erp computerAccess is disabled
recolector-documentos computerAccess is enabled
collector package grants are exactly skill-creator and crear-proveedor-documental
neither target agent has an MCP grant
the active manifest remains absent during staging
```

The stage must not require an ERP credential, ERP MCP server, `openbot-jefe-erp` principal, or four ERP grants.

- [ ] **Step 3: Run the stage tests to verify the old ERP assumptions fail**

Run:

```bash
bun test server/tests/reviewed-g1-stage-script.test.ts server/tests/openbot-host-lock-contract.test.ts server/tests/recover-openbot-g0-baseline.test.ts server/tests/docker-descriptor-format.test.ts
```

Expected: the lock/descriptor tests pass; stage-contract cases that still expect ERP material fail.

- [ ] **Step 4: Adapt staging and verification to the document-agent contract**

In `stage-reviewed-g1.sh` and `verify-staged-g1.sh`:

- keep all ownership, mode, bundle SHA-256, clean-tree, deployment-lock, OCI identity, probe-cleanup, signal, health, rendered-stack, and no-apply checks unchanged;
- keep `accepted_g0_source_commit=ff5aa7ebd8ac798887017bfa1f5a471483b0c499` for this first upgrade only;
- replace ERP token/MCP/grant probes with a stopped candidate probe that loads the Netsfera package and returns the two agents' `computerAccess` values and package skill grants;
- assert zero `kind = 'mcp'` grants for both target agents;
- allow `kind = 'skill'` grants, because skills are instructions rather than capabilities;
- allow no `kind = 'bot'` grant during staging; the directional handoff is enabled after the candidate is live and is separately audited;
- preserve the exact 11-field activation manifest already consumed by the installed helper.

- [ ] **Step 5: Make future baseline promotion tolerate safe instruction grants**

Change the preflight query in `promote-reviewed-g0.sh` so it refuses every grant except skills:

```sql
SELECT agent_id, kind, ref
FROM plugin_grants
WHERE agent_id IN ('jefe-erp', 'recolector-documentos')
  AND kind <> 'skill'
ORDER BY agent_id, kind, ref;
```

Update `server/tests/reviewed-promotion-script.test.ts` to prove a personal/provider skill does not block a reviewed promotion while any `mcp` or `bot` grant does.

- [ ] **Step 6: Run the full deployment-script test set**

Run:

```bash
bun test \
  server/tests/openbot-host-lock-contract.test.ts \
  server/tests/recover-openbot-g0-baseline.test.ts \
  server/tests/reviewed-g1-stage-script.test.ts \
  server/tests/reviewed-promotion-script.test.ts \
  server/tests/reviewed-promotion-wrapper.test.ts \
  server/tests/reviewed-bundle-script.test.ts \
  server/tests/verify-rendered-overlay-script.test.ts \
  server/tests/docker-descriptor-format.test.ts
```

Expected: PASS with no ERP environment or credential available.

- [ ] **Step 7: Commit the persistent activation port**

```bash
git add deploy/netsfera server/tests
git commit -m "feat: stage persistent Netsfera document-agent releases"
```

---

### Task 5: Add an operator runbook and explicit post-deploy handoff step

**Files:**
- Create: `docs/runbooks/netsfera-document-agents-v007.md`
- Modify: `docs/configuration.md`

**Interfaces:**
- Consumes: reviewed bundle/stage/activation scripts and OpenBot's Agent dialog.
- Produces: one reproducible path from local reviewed commit to live exact image, plus the single audited UI action that grants `jefe-erp -> recolector-documentos` handoff.

- [ ] **Step 1: Write the runbook with immutable inputs and stop conditions**

The runbook must state these exact preflight stop conditions:

```text
netsfera-openbot.service is not active
the Compose helper is absent or config -q fails
the source tree is dirty
any required container is unhealthy
the source commit is not ff5aa7ebd8ac798887017bfa1f5a471483b0c499
the activation marker or manifest unexpectedly exists
the approved external Tailscale/ingress route is unknown
the database dump fails
```

It must use `/usr/local/lib/netsfera/openbot-compose-v1.sh`, a mode-0700 directory under `/opt/openbot/.deploy-backups`, mode-0600 backup/evidence files, and SHA-256 checksums.

- [ ] **Step 2: Document the exact post-deploy configuration**

After the candidate is healthy and persistent across a helper restart:

1. Open the `Jefe ERP` agent dialog.
2. Open `Handoff`.
3. Enable only `Recolector de documentos` as a target.
4. Confirm the audit trail records the change.
5. Do not grant the reverse direction.
6. Do not grant an MCP tool to either agent in this release.

Document adding a provider as: review the portal/authentication hosts, update and redeploy the reviewed policy artifact, then invoke `/crear-proveedor-documental`; skill creation never edits policy.

- [ ] **Step 3: Document the current download boundary and future issue contract**

State that v0.0.7 has no governed binary-download tool. The current expected result is `human_save_required`. Link to the design spec's future `computer_download` contract and explicitly exclude `curl` with copied browser credentials as a workaround.

- [ ] **Step 4: Update configuration documentation**

Add `agent.computer_access: enabled|disabled` to the tenant package section of `docs/configuration.md`, including:

```text
omitted in an older package -> materialized as enabled for compatibility
new user-created or duplicated agent -> disabled
explicit disabled -> computer tools and routes unavailable
explicit enabled -> tools/routes exist, but every acting call still requires CEL policy approval
```

- [ ] **Step 5: Verify and commit documentation**

Run:

```bash
rg -n 'ff5aa7e|9aedb57|human_save_required|computer_access|openbot-compose-v1' docs/runbooks/netsfera-document-agents-v007.md docs/configuration.md
git diff --check
```

Expected: every term is present and no whitespace errors occur.

```bash
git add docs/runbooks/netsfera-document-agents-v007.md docs/configuration.md
git commit -m "docs: add Netsfera document-agent rollout runbook"
```

---

### Task 6: Verify the complete candidate locally

**Files:**
- Verify: complete repository

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: one clean immutable candidate commit suitable for reviewed staging.

- [ ] **Step 1: Run formatting, lint, and type checks**

Run:

```bash
bun run format:check
bun run lint
bun run typecheck
```

Expected: all commands exit 0. Use `bun run format` only for files changed by this plan, then rerun the three checks.

- [ ] **Step 2: Run the complete unit test suite**

Run: `bun test`

Expected: exit 0 with no skipped Netsfera safety tests caused by missing source files.

- [ ] **Step 3: Build the complete product with the Netsfera package**

Run:

```bash
TENANT_PACKAGE_DIR=../examples/netsfera bun run build
```

Expected: app, server, worker, supervisor, and agent-computer builds/typechecks complete; the generated app configuration names the Netsfera product.

- [ ] **Step 4: Render the reviewed overlay against the repository Compose file**

Run:

```bash
docker compose -f docker-compose.yml -f deploy/netsfera/docker-compose.erp-agent.yml config --quiet
docker compose -f docker-compose.yml -f deploy/netsfera/docker-compose.erp-agent.yml config --format json > /tmp/openbot-netsfera-v007-render.json
jq -e '.services.openbot.environment.TENANT_PACKAGE_DIR == "../examples/netsfera"' /tmp/openbot-netsfera-v007-render.json
```

Expected: all commands exit 0. Remove only the explicit temporary render after inspection.

- [ ] **Step 5: Review the branch diff and create the immutable candidate**

Run:

```bash
git status --short
git diff v0.0.7...HEAD --check
git log --oneline --decorate v0.0.7..HEAD
```

Expected: clean worktree; the history contains the design, safety port, agent package, browser policy, persistent activation, runbook, and no download/MCP implementation.

- [ ] **Step 6: Record the exact candidate SHA**

Run: `git rev-parse HEAD`

Expected: one 40-hex commit. Use that exact value for every bundle, stage, activation, evidence, and verification call; never substitute the branch name.

---

### Task 7: Stage, approve, activate, and verify on `root@bot`

**Files:**
- Runtime: `/opt/openbot/source`
- Private backup root pattern: `/opt/openbot/.deploy-backups/YYYYMMDDTHHMMSSZ-v007-document-agents`
- Private incoming/evidence root: `/root/openbot-incoming`
- Persistent activation manifest: `/etc/netsfera/bot-zero-trust/openbot-g1-activation.manifest`

**Interfaces:**
- Consumes: Task 6 immutable SHA and reviewed artifacts.
- Produces: healthy restart-persistent OpenBot v0.0.7 with the two existing agents, collector browser/skills, and audited one-way handoff.

- [ ] **Step 1: Obtain the production gate inputs**

Before any server mutation, record in the execution log:

```text
approved immutable candidate SHA
approved maintenance window
backup owner
rollback owner
approved external route and expected HTTP result
```

Stop until all five are concrete.

- [ ] **Step 2: Repeat the read-only preflight**

Run the exact preflight from the `operating-openbot-bot-server` skill. Expected: active service, valid Compose, clean `ff5aa7e...` source, and all required containers healthy.

- [ ] **Step 3: Back up source and PostgreSQL before checkout or build**

Over SSH, run this without reading or expanding either environment file:

```bash
set -euo pipefail
backup_dir="/opt/openbot/.deploy-backups/$(date -u +%Y%m%dT%H%M%SZ)-v007-document-agents"
install -d -o root -g root -m 0700 "$backup_dir"
git -C /opt/openbot/source bundle create "$backup_dir/openbot-source.bundle" HEAD
cd /opt/openbot
/usr/local/lib/netsfera/openbot-compose-v1.sh exec -T postgres \
  pg_dump -U openbot -d openbot -Fc > "$backup_dir/openbot.pgdump"
chmod 0600 "$backup_dir/openbot-source.bundle" "$backup_dir/openbot.pgdump"
sha256sum "$backup_dir/openbot-source.bundle" "$backup_dir/openbot.pgdump" \
  > "$backup_dir/SHA256SUMS"
chmod 0600 "$backup_dir/SHA256SUMS"
sha256sum -c "$backup_dir/SHA256SUMS"
```

Expected: both files report `OK`. Stop if the dump, bundle, or checksum validation fails.

- [ ] **Step 4: Create and verify the reviewed bundle locally**

Run:

```bash
candidate_sha="$(git rev-parse HEAD)"
artifact_dir="$(mktemp -d)"
chmod 0700 "$artifact_dir"
bundle_path="$artifact_dir/openbot-v007-document-agents.bundle"
deploy/netsfera/create-reviewed-bundle.sh "$candidate_sha" "$bundle_path"
bundle_sha256="$(sha256sum "$bundle_path" | awk '{print $1}')"
git bundle verify "$bundle_path"
git bundle list-heads "$bundle_path" | grep -Fx \
  "$candidate_sha refs/netsfera-review/$candidate_sha"
```

Transfer the bundle and only the wrapper/stage script bytes extracted from that same `candidate_sha`; never execute a script copied from the mutable worktree after the commit was recorded.

- [ ] **Step 5: Stage without applying**

Execute `verify-reviewed-g1-stage-wrapper.sh` on `root@bot`. Expected evidence must state the exact candidate commit/image/config/index/descriptor identities, current G0 baseline, functional overlay hash, candidate render hash, and `live_container_unchanged=true`. Confirm the active manifest is still absent.

- [ ] **Step 6: Review stage evidence before activation**

Compare every evidence field to the candidate commit and local reviewed artifacts. Verify the stopped candidate probe reports:

```text
jefe-erp disabled
recolector-documentos enabled
recolector skills: crear-proveedor-documental, skill-creator
target-agent MCP grants: none
```

Stop on any mismatch.

- [ ] **Step 7: Activate under the shared deployment lock**

Acquire `/var/lock/openbot-deployment.lock`, verify it is root-owned mode 0600 and the inherited FD identity matches, install the reviewed activation manifest with `manage-openbot-g1-activation-v1.sh`, and run:

```bash
/usr/local/lib/netsfera/openbot-compose-v1.sh --lock-held-fd 9 up --detach --remove-orphans
```

Do not run bare `docker compose` and do not create the forbidden legacy marker.

- [ ] **Step 8: Verify health, exact identity, persistence, and external reachability**

Repeat preflight, verify the running OpenBot image matches the staged exact descriptor, execute the approved external request, then invoke the helper a second time and prove the same exact image and functional overlay remain active. Verify all required containers remain healthy with zero new restart loops.

- [ ] **Step 9: Verify decision components, then enable and audit one-way handoff**

In Admin → Components, verify `Approval` (`askApproval`) and `Choice` (`askChoice`) are published and are not withheld from `recolector-documentos`. If either is withheld, allow it and confirm the configuration change is audited. Then use the authenticated Agent dialog to grant only `jefe-erp -> recolector-documentos`. Verify the database/audit view shows one `kind = 'bot'`, `ref = 'recolector-documentos'` grant on `jefe-erp` and no reverse grant.

- [ ] **Step 10: Run the interactive acceptance journey**

Verify, in order:

1. Existing channels and history remain reachable.
2. Jefe ERP has no browser tools and can hand a request to the collector.
3. The collector can navigate to an already reviewed host.
4. An unreviewed host is refused and names the rule.
5. Login takeover and return work.
6. `/crear-proveedor-documental` interviews, rehearses, and renders the native save card.
7. Saving creates a personal skill but does not attach it silently.
8. `Put it on a Bot` attaches it to the collector.
9. A provider run lists documents and asks for choice/approval before acting.
10. Rejection does nothing; approval ends at a truthful `human_save_required` fallback.

- [ ] **Step 11: Preserve evidence and state the rollback boundary**

Record source SHA, exact image references/digests, Compose render hash, backup checksums, health output, external journey result, agent entitlements, grants, and audit event ids in the private evidence directory. If failure occurs before migrations, restore the recorded source/image through the reviewed helper path. If migrations ran, stop and use the approved database restore decision; do not perform a code-only rollback and assume schema compatibility.

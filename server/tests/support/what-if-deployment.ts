import type { WhatIfVocabulary } from "@openbot/shared/what-if";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { createEnterpriseStore } from "../../src/admin/settings-store";
import { createApprovalStore } from "../../src/approvals/store";
import type { ActionPolicy } from "../../src/computer/policy";
import type { Database } from "../../src/db/client";
import {
  agentProfiles,
  agents,
  approvalTeamRules,
  capabilitySettings,
  enterpriseSettings,
  mcpServers,
  mcpTools,
  networkPolicies,
  pluginGrants,
  userRoles,
  users,
} from "../../src/db/schema";

/**
 * One small OpenBot for "What would happen if…": two Bots, three people, two apps, and a setting on
 * every control, written through the stores the admin screens write through.
 *
 * The ids are fixed rather than random, because the model's answers in `fixtures/what-if-recorded.json`
 * were recorded naming them. Every row starts with `whatif-` so the test's vocabulary can be narrowed
 * to this OpenBot whatever else the test database holds, and the prompt is the one recorded.
 */
export const ADMIN = {
  id: "whatif-admin",
  email: "admin@whatif.test",
  name: "Avery Admin",
};
export const SAM = {
  id: "whatif-sam",
  email: "sam@whatif.test",
  name: "Sam Lee",
  groups: ["whatif-sales"],
};
export const CASEY = {
  id: "whatif-casey",
  email: "casey@whatif.test",
  name: "Casey Moore",
  groups: ["whatif-contractors"],
};
export const SALES_BOT = { id: "whatif-sales", name: "Sales", owner: SAM.id };
export const RESEARCH_BOT = {
  id: "whatif-research",
  name: "Research",
  owner: CASEY.id,
};
export const GMAIL = "whatif-gmail";
export const CRM = "whatif-crm";

export const NO_UNATTENDED_EMAIL = `initiator.kind == "routine" && mcp.server == "${GMAIL}" && mcp.effect == "write"`;
export const NO_SOCIAL = `intent == "navigate" && (page.host == "www.linkedin.com" || page.host == "linkedin.com")`;

/** The boundary, as the Boundaries page saves one: two named deny rules, and everything else allowed. */
export const POLICY: ActionPolicy = {
  mode: "enforce",
  deny: [NO_UNATTENDED_EMAIL, NO_SOCIAL],
  allow: ["true"],
  labels: {
    [NO_UNATTENDED_EMAIL]: {
      name: "No email when nobody is watching",
      description: "Stops a routine sending or changing anything in Gmail.",
    },
    [NO_SOCIAL]: {
      name: "No social media",
      description: "Stops a Bot opening LinkedIn.",
    },
    true: { name: "Everything else", description: "Allows the rest." },
  },
};

const TOOLS = [
  { serverId: GMAIL, name: "send_email", effect: "write", destructive: false },
  { serverId: GMAIL, name: "list_emails", effect: "read", destructive: false },
  { serverId: GMAIL, name: "delete_email", effect: "write", destructive: true },
  { serverId: CRM, name: "update_record", effect: "write", destructive: false },
  { serverId: CRM, name: "get_record", effect: "read", destructive: false },
];

/** The approval rule an admin set for the team: any Bot listing emails asks first. */
export const LIST_EMAILS_ASKS = {
  botId: "*",
  toolRef: `${GMAIL}/list_emails`,
  effect: "*",
  scope: "*",
  behaviour: "ask" as const,
};

export async function seedWhatIf(database: Database): Promise<void> {
  await clearWhatIf(database);
  await database
    .insert(users)
    .values([{ ...ADMIN, groups: [] }, { ...SAM }, { ...CASEY }]);
  await database.insert(userRoles).values({ userId: ADMIN.id, role: "admin" });
  for (const bot of [SALES_BOT, RESEARCH_BOT]) {
    await database.insert(agents).values({
      id: bot.id,
      name: bot.name,
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: bot.id,
      ownerUserId: bot.owner,
      title: "",
      roleDescription: "",
      avatarSeed: bot.id,
      visibility: "public",
    });
  }
  await database.insert(mcpServers).values([
    {
      id: GMAIL,
      title: "Gmail",
      vendor: "Google",
      url: "https://gmail.whatif.test/mcp",
      provenance: "custom",
    },
    {
      id: CRM,
      title: "CRM",
      vendor: "Acme",
      url: "https://crm.whatif.test/mcp",
      provenance: "custom",
    },
  ]);
  await database.insert(mcpTools).values(
    TOOLS.map((tool) => ({
      ...tool,
      vendorName: tool.name,
      inputSchema: {},
    })),
  );
  // The Sales Bot may send and list mail; the Research Bot may read the CRM. Nothing else.
  await database.insert(pluginGrants).values([
    { kind: "mcp", ref: `${GMAIL}/send_email`, agentId: SALES_BOT.id },
    { kind: "mcp", ref: `${GMAIL}/list_emails`, agentId: SALES_BOT.id },
    { kind: "mcp", ref: `${CRM}/get_record`, agentId: RESEARCH_BOT.id },
  ]);

  const enterprise = createEnterpriseStore(database);
  // Only Gmail may be called.
  await enterprise.setSetting(
    "mcpAllowlist",
    { enabled: true, servers: [GMAIL] },
    ADMIN.id,
  );
  // Members can't run commands on a computer; the sales group can.
  await enterprise.setCapability(
    {
      scopeKind: "role",
      scopeId: "user",
      capability: "cloudComputer",
      allowed: false,
    },
    ADMIN.id,
  );
  await enterprise.setCapability(
    {
      scopeKind: "group",
      scopeId: "whatif-sales",
      capability: "cloudComputer",
      allowed: true,
    },
    ADMIN.id,
  );
  // The sales group's Bots open only Google Mail and LinkedIn.
  await enterprise.setNetworkPolicy(
    {
      scopeKind: "group",
      scopeId: "whatif-sales",
      mode: "allowlist_only",
      rules: [
        { type: "domain", value: "mail.google.com" },
        { type: "domain", value: "www.linkedin.com" },
      ],
      locked: false,
    },
    ADMIN.id,
  );

  const approvals = createApprovalStore(database);
  await approvals.policy?.createTeamRule(ADMIN.id, LIST_EMAILS_ASKS);
}

/** Every row {@link seedWhatIf} writes, apart from the trail, which keeps what it is given. */
export async function clearWhatIf(database: Database): Promise<void> {
  await database
    .delete(approvalTeamRules)
    .where(eq(approvalTeamRules.toolRef, LIST_EMAILS_ASKS.toolRef));
  await database
    .delete(networkPolicies)
    .where(
      and(
        eq(networkPolicies.scopeKind, "group"),
        eq(networkPolicies.scopeId, "whatif-sales"),
      ),
    );
  await database
    .delete(capabilitySettings)
    .where(
      or(
        and(
          eq(capabilitySettings.scopeKind, "role"),
          eq(capabilitySettings.scopeId, "user"),
          eq(capabilitySettings.capability, "cloudComputer"),
        ),
        eq(capabilitySettings.scopeId, "whatif-sales"),
      ),
    );
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, "mcp_allowlist"));
  await database
    .delete(pluginGrants)
    .where(like(pluginGrants.agentId, "whatif-%"));
  await database
    .delete(mcpTools)
    .where(inArray(mcpTools.serverId, [GMAIL, CRM]));
  await database.delete(mcpServers).where(inArray(mcpServers.id, [GMAIL, CRM]));
  await database.delete(agents).where(like(agents.id, "whatif-%"));
  await database.delete(users).where(like(users.id, "whatif-%"));
}

/** The vocabulary narrowed to this OpenBot, so the prompt is the one the answers were recorded for. */
export function ownVocabulary(vocabulary: WhatIfVocabulary): WhatIfVocabulary {
  const own = (id: string) => id.startsWith("whatif-");
  return {
    bots: vocabulary.bots.filter((bot) => own(bot.id)),
    people: vocabulary.people.filter((person) => own(person.id)),
    groups: vocabulary.groups.filter(own),
    apps: vocabulary.apps.filter((app) => own(app.id)),
  };
}

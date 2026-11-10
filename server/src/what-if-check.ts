/**
 * What each of OpenBot's controls decides about one action, in the order the product applies them.
 *
 * Deterministic: no model is asked anything here. "What would happen if…" (`what-if.ts`) hands this an
 * action an admin confirmed, and "Why did this happen?" hands it the facts an audit row recorded.
 *
 * NOTHING HERE DECIDES. Every verdict comes from the function the live path calls, given the facts it
 * would be given, built by the helpers it builds them with:
 *
 * An app's tool call, as `callTool` takes it (`plugins/plugin-store/calls.ts`):
 *   1. App grants. The plugin store's own `decide` (calls.ts, `this.decide` before anything else).
 *   2. The app allowlist, then 3. Permissions (Use Bots). The enterprise controls' overlay, asked
 *      first inside `evaluateActionPolicy` (calls.ts), here through `enterpriseChecks`, the same
 *      generator the overlay stops at the first refusal of (`admin/controls.ts`).
 *   4. Boundaries. The policy's own rules, `evaluateBoundaryRules`, which is what
 *      `evaluateActionPolicy` falls through to (`computer/policy.ts`), on the context
 *      `appCallPolicyContext` builds for the live call and the backtest alike.
 *   5. Safety requirements, then 6. Approvals. The approval gate's `safetyRequirement` and
 *      `decideAction` (`approvals/policy.ts`), which the gate asks last before the vendor.
 *
 * A computer action, as the gateway's `govern` takes it (`computer/gateway.ts`):
 *   1. Permissions (Use Bots, Cloud browser or computer use, Cloud network access), then 2. the
 *      network allowlist for a page being opened: the overlay again, in its order. The network check
 *      is `egressDecision`, imported from `agent-computer/src/egress.ts` by `computer/policy-network.ts`,
 *      the same matcher the computer itself runs on every connection.
 *   3. Boundaries, on the context `contextFromAuditPayload` rebuilds the gateway's with.
 *   4. Safety requirements, then 5. Approvals, asked as the gateway asks the gate
 *      (`approvalEffectOf`, `approvalScopeOf`).
 *
 * Every control is asked, not only the first that refuses, so an admin sees what each one says and
 * which one settles it. The ones a real action would never reach are marked so.
 */

import { appToolName, connectorName } from "@openbot/shared/tool-name";
import type {
  WhatIfLayer,
  WhatIfLayerId,
  WhatIfOutcome,
  WhatIfResult,
  WhatIfVerdict,
} from "@openbot/shared/what-if";
import type { AuditInitiator } from "@openbot/toolkit/initiator";
import {
  CAPABILITY_LABELS,
  type Capability,
  type CapabilityAnswer,
} from "./admin/capabilities";
import {
  type EnterpriseCheck,
  type EnterpriseSnapshot,
  enterpriseChecks,
} from "./admin/controls";
import {
  closedKind,
  decideAction,
  reviewable,
  safetyRequirement,
  strictestRule,
} from "./approvals/policy";
import type {
  ApprovalCandidate,
  ApprovalPolicyStore,
  ApprovalRule,
  ApprovalTeamRule,
} from "./approvals/types";
import { approvalEffectOf, approvalScopeOf } from "./computer/gateway";
import {
  type ActionPolicy,
  evaluateBoundaryRules,
  type PolicyContext,
  type PolicyDecision,
} from "./computer/policy";
import { appCallPolicyContext } from "./plugins/plugin-store/call-policy";
import type { PluginDecision } from "./plugins/plugin-store/model";

/** Where the deciders read this OpenBot's settings from: the same stores the live path reads. */
export type GovernanceReaders = {
  /** The boundary policy in force. */
  policy: () => ActionPolicy | null | undefined;
  /**
   * The enterprise controls' snapshot, the one the overlay answers from. `null` where no controls
   * are installed (a script, a test of something else), where the overlay says nothing and the
   * boundary decides alone. `undefined` inside means installed and not loaded, which refuses.
   */
  enterprise: () => { snapshot: EnterpriseSnapshot | undefined } | null;
  /** The plugin store's `decide`: has this Bot been given this tool. */
  grant: (ref: string, botId: string) => Promise<PluginDecision>;
  /** The approval gate's settings and rules. Absent where no gate is wired, so nothing asks. */
  approvals?: {
    policy: ApprovalPolicyStore;
    rules: (ownerUserId: string) => Promise<ApprovalRule[]>;
  };
};

/** The names an answer gives the values it talks about. */
export type CheckNames = {
  bot: string;
  /** The person, or "a member of <group>". */
  person: string;
  app?: string;
};

/**
 * The facts one action is judged on. An app call's are `callTool`'s; a computer action's are the
 * context the gateway builds, with what it asks the approval gate about.
 */
export type CheckFacts =
  | {
      surface: "app";
      /** `<app>/<tool>`. */
      ref: string;
      botId: string;
      /** Whose authority it runs on. Empty for a member of a group, who is nobody in particular. */
      actorId: string;
      /** For "any member of this group": who the controls are asked about instead of a person. */
      group?: string;
      initiator?: AuditInitiator;
      /** The app's classification of the tool, as `callTool` makes it. */
      effect: "read" | "write";
      /** The app marks the tool destructive. */
      destructive: boolean;
    }
  | {
      surface: "computer";
      context: PolicyContext;
      group?: string;
      /** What the gateway hands the approval gate as `target` and `args`. */
      target: { pageUrl: string; element?: unknown; filePath?: string };
      args: Record<string, unknown>;
      filePath?: string;
      command?: string;
    };

/** Who a member of a group is to the controls: an id nobody holds, in that group only. */
const GROUP_MEMBER = "what-if:member-of:";

const TITLES: Record<WhatIfLayerId, string> = {
  grant: "App grants",
  app_allowlist: "App allowlist",
  capabilities: "Permissions",
  network: "Network allowlist",
  boundaries: "Boundaries",
  safety: "Safety requirements",
  approvals: "Approvals",
};

/** The controls each kind of action passes, in the order the live path asks them. */
const ORDER: Record<"app" | "computer", WhatIfLayerId[]> = {
  app: [
    "grant",
    "app_allowlist",
    "capabilities",
    "boundaries",
    "safety",
    "approvals",
  ],
  computer: ["capabilities", "network", "boundaries", "safety", "approvals"],
};

/** What a built-in safety requirement is about, for an admin rather than the person it asks. */
const SAFETY_WORDS: Record<string, string> = {
  credentials: "changing a password or other credential",
  security_settings: "changing security, sharing or access settings",
  payments: "paying or moving money",
  deleting: "deleting something",
  sending: "sending something to other people",
  sharing: "sharing something with other people",
  publishing: "posting or publishing something",
};

type Layer = Omit<WhatIfLayer, "decides" | "unreached">;

function layer(
  id: WhatIfLayerId,
  verdict: WhatIfVerdict,
  summary: string,
  extra: Partial<Layer> = {},
): Layer {
  return { id, title: TITLES[id], verdict, summary, ...extra };
}

/** Who the controls are asked about, as the policy context names them. */
function actorOf(facts: { actorId: string; group?: string }): string {
  return facts.group ? `${GROUP_MEMBER}${facts.group}` : facts.actorId;
}

/**
 * The snapshot with a member of the group in it, where the action is about any member of a group.
 * The overlay reads a person's groups from the snapshot, so this is the one way to ask it about a
 * member who is nobody in particular. Nothing else in the snapshot changes.
 */
function snapshotFor(
  snapshot: EnterpriseSnapshot | undefined,
  group: string | undefined,
): EnterpriseSnapshot | undefined {
  if (!snapshot || !group) return snapshot;
  const groupsByUser = new Map(snapshot.groupsByUser);
  groupsByUser.set(`${GROUP_MEMBER}${group}`, [group]);
  return { ...snapshot, groupsByUser };
}

/** Where a capability's answer came from, in words. */
function capabilitySource(answer: CapabilityAnswer): string {
  switch (answer.decidedBy) {
    case "group":
      return `the group ${answer.scopeId} turns it on`;
    case "role":
      return answer.scopeId === "admin" ? "set for admins" : "set for members";
    case "organization":
      return "set for everybody";
    default:
      return "OpenBot's default";
  }
}

function capabilityLayer(
  checks: Extract<EnterpriseCheck, { control: "capability" }>[],
  who: string,
): Layer {
  const off = checks.find((check) => !check.answer.allowed);
  const title = (capability: Capability) =>
    `"${CAPABILITY_LABELS[capability].title}"`;
  if (off)
    return layer(
      "capabilities",
      "refuses",
      `${title(off.capability)} is off for ${who}, ${capabilitySource(off.answer)}.`,
      {
        basis: CAPABILITY_LABELS[off.capability].title,
        page: "/admin/permissions",
      },
    );
  return layer(
    "capabilities",
    "allows",
    `${listed(checks.map((check) => title(check.capability)))} ${checks.length === 1 ? "is" : "are"} on for ${who}${
      checks.length === 1
        ? `, ${capabilitySource((checks[0] as (typeof checks)[number]).answer)}`
        : ""
    }.`,
    { page: "/admin/permissions" },
  );
}

function listed(items: string[]): string {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * The enterprise controls' layers, from the overlay's own checks. With no controls installed the
 * overlay says nothing, and these say so rather than inventing an answer.
 */
function enterpriseLayers(
  readers: GovernanceReaders,
  context: PolicyContext,
  group: string | undefined,
  names: CheckNames,
): Partial<Record<WhatIfLayerId, Layer>> {
  const installed = readers.enterprise();
  const isApp = Boolean(context.mcp?.server);
  if (!installed) {
    const none = "No admin controls are set up on this OpenBot.";
    return {
      capabilities: layer("capabilities", "allows", none),
      ...(isApp
        ? { app_allowlist: layer("app_allowlist", "allows", none) }
        : context.intent === "navigate"
          ? { network: layer("network", "allows", none) }
          : {}),
    };
  }
  const checks = [
    ...enterpriseChecks(snapshotFor(installed.snapshot, group), context),
  ];
  const layers: Partial<Record<WhatIfLayerId, Layer>> = {};
  const capabilities: Extract<EnterpriseCheck, { control: "capability" }>[] =
    [];
  for (const check of checks) {
    if (check.control === "unavailable") {
      layers.capabilities = layer(
        "capabilities",
        "refuses",
        "The admin controls haven't loaded, so OpenBot refuses every action until they do.",
        { page: "/admin/permissions" },
      );
    } else if (check.control === "app_allowlist") {
      const app = names.app ?? connectorName(check.server);
      layers.app_allowlist = check.refusal
        ? layer(
            "app_allowlist",
            "refuses",
            `${app} isn't on the approved list, and only approved apps can be called.`,
            { basis: "Only approved servers", page: "/admin/plugins" },
          )
        : layer(
            "app_allowlist",
            "allows",
            !check.enabled
              ? "The allowlist is off, so any app a Bot has been given can be called."
              : check.builtIn
                ? `${app} is built in, so the allowlist never holds it back.`
                : `${app} is on the approved list.`,
            { page: "/admin/plugins" },
          );
    } else if (check.control === "capability") {
      capabilities.push(check);
    } else if (check.control === "network") {
      // "none" is no allowlist at all, which lets everything through: `NO_NETWORK_POLICY`.
      const where =
        check.policy.from === "organization"
          ? "the network allowlist for everybody"
          : check.policy.from.startsWith("group:")
            ? `the network allowlist for the group ${check.policy.from.slice(6)}`
            : null;
      layers.network = !check.decision
        ? layer(
            "network",
            "allows",
            `Only the Bot's computer can decide this, when it connects: ${where ?? "the network allowlist"} names IP ranges, and ${check.host}'s address isn't known until then.`,
            {
              page: "/admin/computers",
              caveat:
                "The computer checks the address when it connects, and refuses it there if it's outside every allowed range.",
            },
          )
        : layer(
            "network",
            check.decision.allowed ? "allows" : "refuses",
            !where
              ? check.decision.allowed
                ? `No network allowlist applies here, so ${check.host} can be opened.`
                : `${check.host} can't be opened. ${check.decision.reason}`
              : check.decision.allowed
                ? `${check.host} is allowed by ${where}.`
                : `${check.host} isn't allowed by ${where}.`,
            {
              ...(where ? { basis: where.replace(/^the n/, "N") } : {}),
              page: "/admin/computers",
            },
          );
    }
  }
  if (capabilities.length > 0 && !layers.capabilities)
    layers.capabilities = capabilityLayer(capabilities, names.person);
  return layers;
}

/** The boundary's own rules on the action. A rule by its name where the Boundaries page gives one. */
export function boundaryLayer(decision: PolicyDecision): Layer {
  // A whole subject, so an unnamed rule reads "A rule with no name allows it", never "The rule a rule".
  const named = decision.ruleName
    ? `The rule "${decision.ruleName}"`
    : decision.matched
      ? "A rule with no name"
      : "A rule";
  const extra = {
    page: "/admin/boundaries" as const,
    ...(decision.ruleName ? { basis: decision.ruleName } : {}),
    ...(decision.matched ? { rule: decision.matched } : {}),
  };
  if (decision.allowed)
    return layer("boundaries", "allows", `${named} allows it.`, extra);
  const trial = decision.forward;
  const why =
    decision.source === "deny"
      ? `${named} refuses it.`
      : "No rule allows it, and an action no rule allows is refused.";
  return layer(
    "boundaries",
    trial ? "trial" : "refuses",
    trial
      ? `${why} Boundaries are in trial mode, so it's recorded and let through.`
      : why,
    extra,
  );
}

/** The approval gate on the action: its safety floor, then the rules and the person's settings. */
async function approvalLayers(
  readers: GovernanceReaders,
  candidate: ApprovalCandidate,
  group: string | undefined,
  appName: (id: string) => string = connectorName,
): Promise<{ safety: Layer; approvals: Layer }> {
  const safety = safetyRequirement(candidate);
  const words = safety ? (SAFETY_WORDS[safety.id] ?? "this") : "";
  // Before the approvals are read: a kind OpenBot always hands to the person, or none at all.
  const fixedSafety: Layer | undefined = !safety
    ? layer(
        "safety",
        "allows",
        candidate.effect === "read"
          ? "It only reads, and no built-in safety requirement applies to a read."
          : "No built-in safety requirement applies.",
      )
    : safety.behaviour === "hand_off"
      ? layer(
          "safety",
          "hands_off",
          `Built in: ${words} is always done by the person.`,
        )
      : undefined;
  /*
   * A kind of action that asks (deleting, sending, sharing, posting, paying, account changes) is open
   * by default: it asks unless an allow saved from that kind's card covers it, and an admin can close
   * it to ask every time or to leave it to the person. So this layer is read from what the gate did.
   */
  const kindLayer = (
    outcome: Awaited<ReturnType<typeof decideAction>>,
    actionKinds: Parameters<typeof closedKind>[1],
  ): Layer => {
    if (fixedSafety) return fixedSafety;
    const id = safety?.id as Parameters<typeof closedKind>[0];
    const closed = closedKind(id, actionKinds);
    if (closed?.behaviour === "hand_off")
      return layer(
        "safety",
        "hands_off",
        `The team set ${words} to be left to the person.`,
        { page: "/admin/approvals", basis: "Actions that ask first" },
      );
    if (closed)
      return layer(
        "safety",
        "asks",
        `The team set ${words} to ask every time, with Allow once and Deny only.`,
        { page: "/admin/approvals", basis: "Actions that ask first" },
      );
    const asksFirst = safety?.reason.startsWith("The app marks")
      ? "the app marks this tool as deleting or overwriting something, so it asks the person first"
      : `${words} asks the person first`;
    if (outcome.source === "safety")
      return layer(
        "safety",
        "asks",
        `Built in: ${asksFirst}. They can allow it once, for the conversation, or always.`,
      );
    // A rule, or an allow the person saved for this kind, decides it: the approvals layer says which.
    return layer(
      "safety",
      "allows",
      `Built in: ${asksFirst}, unless a rule or an allow saved for it decides. Here one does.`,
    );
  };

  if (!readers.approvals)
    return {
      safety:
        fixedSafety ??
        layer("safety", "asks", `Built in: ${words} asks the person first.`),
      approvals: layer(
        "approvals",
        "allows",
        "Approvals aren't set up on this OpenBot.",
      ),
    };

  const { policy } = readers.approvals;
  const owner = group ? "" : candidate.actorId;
  const [preferences, team, teamRules, personal] = await Promise.all([
    policy.preferences(owner),
    policy.teamSettings(),
    policy.teamRules(),
    owner ? readers.approvals.rules(owner) : Promise.resolve([]),
  ]);
  /*
   * The gate's own decision, as `approvals/service.ts` asks it, without the AI reviewer: it needs
   * the person's request in that run, which a what-if doesn't have. Whether it would look is said
   * beside the answer.
   */
  const outcome = await decideAction({
    candidate,
    team: teamRules,
    personal,
    customRulesEnabled: team.customRulesEnabled,
    autoReview: false,
    askBeforeChanges: preferences.enabled,
    actionKinds: team.actionKinds,
  });
  const reviewer =
    (preferences.autoReview || team.enforceAutoReview) && reviewable(candidate)
      ? "The AI reviewer also looks at this when it runs, and can ask the person first."
      : undefined;
  const matched = strictestRule(
    candidate,
    teamRules,
    team.customRulesEnabled ? personal : [],
    safety && safety.behaviour !== "hand_off" ? { kind: safety.id } : {},
  );
  const whose =
    matched?.layer === "team_rule" ? "A team rule" : "A personal rule";
  const ruleText = matched ? ruleWords(matched.rule, appName) : undefined;
  const ruleExtra = {
    page: "/admin/approvals" as const,
    ...(ruleText ? { basis: ruleText } : {}),
    ...(reviewer ? { caveat: reviewer } : {}),
  };

  let approvals: Layer;
  if (outcome.source === "safety") {
    /*
     * The safety floor settled it before any rule was read, so this layer is never reached. What the
     * rules would say is still worth seeing, from the rule the gate would have found.
     */
    approvals = matched
      ? layer(
          "approvals",
          behaviourVerdict(matched.rule.behaviour),
          `${whose} would ${behaviourWords(matched.rule.behaviour)}.`,
          ruleExtra,
        )
      : layer("approvals", "allows", "No rule asks about this.", ruleExtra);
  } else if (
    outcome.ruleId &&
    matched?.rule.behaviour === "pre_approved" &&
    outcome.behaviour === "ask"
  ) {
    approvals = layer(
      "approvals",
      "asks",
      `${whose} lets it run only when the person asked for exactly this in that run. Otherwise it asks.`,
      ruleExtra,
    );
  } else if (outcome.ruleId) {
    approvals = layer(
      "approvals",
      behaviourVerdict(outcome.behaviour),
      `${whose} ${behaviourWords(outcome.behaviour, true)}.`,
      ruleExtra,
    );
  } else if (outcome.behaviour === "ask") {
    approvals = layer(
      "approvals",
      "asks",
      group
        ? "This member's settings ask before changes."
        : "This person asks to review changes before they happen.",
      { ...ruleExtra, basis: "Ask before making changes" },
    );
  } else {
    approvals = layer(
      "approvals",
      "allows",
      group
        ? "No rule asks about this, with OpenBot's default settings for a member."
        : "No rule or setting asks about this.",
      ruleExtra,
    );
  }
  return { safety: kindLayer(outcome, team.actionKinds), approvals };
}

function behaviourVerdict(
  behaviour: ApprovalRule["behaviour"] | "deny",
): WhatIfVerdict {
  if (behaviour === "allow") return "allows";
  if (behaviour === "hand_off") return "hands_off";
  if (behaviour === "deny") return "refuses";
  return "asks";
}

function behaviourWords(
  behaviour: ApprovalRule["behaviour"] | "deny",
  present = false,
): string {
  switch (behaviour) {
    case "allow":
      return present
        ? "lets it run without asking"
        : "let it run without asking";
    case "hand_off":
      return present
        ? "hands it to the person to do"
        : "hand it to the person to do";
    case "pre_approved":
      return present
        ? "lets it run only when the person asked for it"
        : "let it run only when the person asked for it";
    case "deny":
      return present ? "refuses it" : "refuse it";
    default:
      return present ? "asks the person first" : "ask the person first";
  }
}

/** A rule as an admin reads it on the Approvals page: what it covers. */
function ruleWords(
  rule: Pick<ApprovalTeamRule, "botId" | "toolRef" | "effect" | "scope">,
  appName: (id: string) => string,
): string {
  const slash = rule.toolRef.indexOf("/");
  const app = rule.toolRef.slice(0, slash);
  const tool =
    rule.toolRef === "*"
      ? "any action"
      : rule.toolRef.endsWith("/*")
        ? `anything on ${appName(app)}`
        : slash > 0
          ? `"${appToolName(app, rule.toolRef.slice(slash + 1)).label}" on ${appName(app)}`
          : rule.toolRef;
  const effect =
    rule.effect === "write"
      ? ", changes only"
      : rule.effect === "read"
        ? ", reads only"
        : "";
  const bot = rule.botId === "*" ? "any Bot" : "one Bot";
  return `${tool}${effect}, ${bot}`;
}

/**
 * Who settles the action, and how. The first control that doesn't let it through settles it; a
 * boundary in trial mode records and lets it through, so it settles nothing.
 */
function settle(layers: Layer[]): {
  outcome: WhatIfOutcome;
  decidedBy: WhatIfLayerId | null;
} {
  for (const entry of layers) {
    if (entry.verdict === "refuses")
      return { outcome: "refused", decidedBy: entry.id };
    if (entry.verdict === "asks")
      return { outcome: "asks", decidedBy: entry.id };
    if (entry.verdict === "hands_off")
      return { outcome: "hands_off", decidedBy: entry.id };
  }
  return { outcome: "allowed", decidedBy: null };
}

const OUTCOME_WORDS: Record<WhatIfOutcome, string> = {
  allowed: "Allowed",
  refused: "Refused",
  asks: "Asks the person first",
  hands_off: "The person has to do it",
};

function finish(
  surface: "app" | "computer",
  found: Partial<Record<WhatIfLayerId, Layer>>,
  notChecked: string[],
  effect?: "read" | "write",
): WhatIfResult {
  const ordered = ORDER[surface]
    .map((id) => found[id])
    .filter((entry): entry is Layer => entry !== undefined);
  const { outcome, decidedBy } = settle(ordered);
  const at = decidedBy
    ? ordered.findIndex((entry) => entry.id === decidedBy)
    : -1;
  const layers: WhatIfLayer[] = ordered.map((entry, index) => ({
    ...entry,
    decides: index === at,
    unreached: at !== -1 && index > at,
  }));
  const decider = layers.find((entry) => entry.decides);
  const trial = layers.find((entry) => entry.verdict === "trial");
  const headline = decider
    ? `${OUTCOME_WORDS[outcome]}. ${decider.title} decide${decider.title.endsWith("s") ? "" : "s"} it.`
    : trial
      ? "Allowed. A boundary in trial mode would refuse it, and records that."
      : "Allowed. Every control lets it through.";
  const applies = new Set(ORDER[surface]);
  return {
    outcome,
    decidedBy,
    headline,
    layers,
    notApplicable: (Object.keys(TITLES) as WhatIfLayerId[])
      .filter((id) => !applies.has(id))
      .map((id) => TITLES[id]),
    notChecked,
    ...(effect ? { effect } : {}),
  };
}

/** Every control's answer about one action, and which one settles it. */
export async function checkAction(
  facts: CheckFacts,
  readers: GovernanceReaders,
  names: CheckNames,
): Promise<WhatIfResult> {
  if (facts.surface === "app") {
    const [server = "", ...rest] = facts.ref.split("/");
    const tool = rest.join("/");
    const actor = actorOf(facts);
    const toolWords = `"${appToolName(server, tool).label}" on ${names.app ?? connectorName(server)}`;
    const grant = await readers.grant(facts.ref, facts.botId);
    const found: Partial<Record<WhatIfLayerId, Layer>> = {
      grant: grant.allowed
        ? layer(
            "grant",
            "allows",
            `${names.bot} has been given ${toolWords}.`,
            { page: "/admin/plugins" },
          )
        : layer(
            "grant",
            "refuses",
            `${names.bot} hasn't been given ${toolWords}, and a Bot can only use the tools it's given.`,
            {
              basis: `${names.app ?? connectorName(server)}: ${tool}`,
              page: "/admin/plugins",
            },
          ),
    };
    const context = appCallPolicyContext({
      ref: facts.ref,
      botId: facts.botId,
      actorId: actor,
      effect: facts.effect,
      ...(facts.initiator ? { initiator: facts.initiator } : {}),
    });
    Object.assign(
      found,
      enterpriseLayers(readers, context, facts.group, names),
    );
    found.boundaries = boundaryLayer(
      evaluateBoundaryRules(readers.policy(), context),
    );
    /*
     * As `callTool` asks the gate, with nothing in the arguments: what a call would send is not
     * known here, and the safety floor is read from the tool's name, which is.
     */
    Object.assign(
      found,
      await approvalLayers(
        readers,
        {
          actorId: actor,
          botId: facts.botId,
          toolRef: facts.ref,
          effect: facts.effect,
          scope: server,
          args: {},
          ...(facts.destructive ? { destructive: true as const } : {}),
        },
        facts.group,
        (id) => (id === server && names.app ? names.app : connectorName(id)),
      ),
    );
    return finish(
      "app",
      found,
      [
        "Whether what it sends holds a password or a key. A call that does is refused.",
        ...(facts.effect === "write"
          ? [
              "Who it sends to. Sending private information to somebody new asks the owner first.",
              "Who can reach the Bot, for an app with one shared account.",
            ]
          : []),
        "What the person already answered in that conversation.",
      ],
      facts.effect,
    );
  }

  const { context } = facts;
  const found = enterpriseLayers(readers, context, facts.group, names);
  found.boundaries = boundaryLayer(
    evaluateBoundaryRules(readers.policy(), context),
  );
  Object.assign(
    found,
    await approvalLayers(
      readers,
      {
        actorId: context.actor.id,
        botId: context.bot.id,
        toolRef: context.tool.name,
        effect: approvalEffectOf(context.intent),
        scope: approvalScopeOf({
          filePath: facts.filePath,
          command: facts.command,
          pageUrl: facts.target.pageUrl,
        }),
        args: facts.args,
        target: facts.target,
      },
      facts.group,
    ),
  );
  return finish("computer", found, [
    ...(context.element?.name || context.intent === "navigate"
      ? []
      : [
          "What's on the page when it acts. A rule about a button's or a field's label can only match one you name.",
        ]),
    "What the person already answered in that conversation.",
  ]);
}

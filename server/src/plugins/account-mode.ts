import type { ApprovalPolicyStore } from "../approvals/types";
import { type AuditStore, recordAuditEvent } from "../audit";
import {
  type AccountMode,
  type Holder,
  mintDeploymentVendorUserId,
} from "./shared-accounts";
import { exposureOf, type SharedUseApproval } from "./shared-use";
import type { SharedUseStore } from "./shared-use-store";
import type { PluginStore } from "./store";

export type AccountModePreview = {
  mode: AccountMode;
  wouldRevoke: { holder: Holder; count: number };
  bots: { botId: string; exposure: SharedUseApproval }[];
};
export type AccountModeResult =
  | { changed: false; preview: AccountModePreview }
  | { changed: true; revoked: number }
  | { changed: false; failures: { account: string; error: string }[] };

/**
 * Personal ⇄ Shared, as one decision an administrator makes once.
 *
 * NOTHING CHANGES UNTIL EVERY OLD ACCOUNT IS ENDED AT THE VENDOR. A switch that half-happened would
 * leave people's mailboxes attached to an app that no longer reaches them, or a team account
 * attached to an app that no longer uses it — standing grants nothing on screen accounts for. So a
 * failed revoke leaves the mode alone; the rows of accounts that WERE ended are removed, because a
 * row here claiming an account the vendor no longer holds is the other way to lie.
 */
export function createAccountModeSwitch(deps: {
  store: PluginStore;
  sharedUse: SharedUseStore;
  teamRules:
    | Pick<
        ApprovalPolicyStore,
        "createTeamRule" | "teamRules" | "revokeTeamRule"
      >
    | undefined;
  deploymentId: string;
  audit: AuditStore;
}) {
  const { store, sharedUse, teamRules } = deps;

  async function preview(
    appId: string,
    mode: AccountMode,
  ): Promise<AccountModePreview> {
    const on = await store.accountsOn(appId);
    const leaving: Holder = mode === "shared" ? "person" : "deployment";
    const bots =
      mode === "shared"
        ? await Promise.all(
            (await sharedUse.botsHolding(appId)).map(async (botId) => ({
              botId,
              exposure: exposureOf(await sharedUse.botFacts(botId)),
            })),
          )
        : [];
    return {
      mode,
      wouldRevoke: {
        holder: leaving,
        count: (on?.accounts ?? []).filter(
          (account) => account.holder === leaving,
        ).length,
      },
      bots,
    };
  }

  /*
   * THE ASK-BEFORE-WRITE RULE A SHARED APP WAS GIVEN, AND ONLY THAT ONE. Matched on every field the
   * switch wrote it with, so a rule an administrator added by hand over the same tools — a
   * different behaviour, a narrower scope — is theirs and outlives the app's mode. Shared by the
   * Personal branch and by removing a Shared app, which both end the one account the rule guarded.
   * `serverId` is resolved to the app first, because that is the id the rule was written under.
   */
  type TeamRule = Awaited<
    ReturnType<NonNullable<typeof teamRules>["teamRules"]>
  >[number];
  const isSwitchRule = (rule: TeamRule, appId: string) =>
    rule.revokedAt === null &&
    rule.botId === "*" &&
    rule.toolRef === `${appId}/*` &&
    rule.scope === appId &&
    rule.effect === "write" &&
    rule.behaviour === "ask";

  async function forgetRule(serverId: string, by: string): Promise<void> {
    if (!teamRules) return;
    const appId = await sharedUse.appIdOf(serverId);
    for (const rule of await teamRules.teamRules()) {
      if (isSwitchRule(rule, appId)) {
        await teamRules.revokeTeamRule(by, rule.id);
      }
    }
  }

  /*
   * WHAT A SHARED APP STANDS ON, MADE TO EXIST — and safe to ask for twice. Each Bot holding the app
   * gets an approval and the app gets its one ask-before-write rule, but only where they are
   * missing: an approval an administrator has since narrowed or widened is theirs and is not written
   * over, and a rule already standing is not duplicated. Returns how many pieces it had to make, so a
   * retry that repaired something says so.
   */
  async function ensureShared(input: {
    appId: string;
    bots: AccountModePreview["bots"];
    approvals: Record<string, SharedUseApproval> | undefined;
    by: string;
    overwrite: boolean;
  }): Promise<number> {
    let made = 0;
    for (const bot of input.bots) {
      if (
        !input.overwrite &&
        (await sharedUse.approvalFor(bot.botId, input.appId))
      ) {
        continue;
      }
      await sharedUse.setApproval({
        botId: bot.botId,
        serverId: input.appId,
        by: input.by,
        approval: input.approvals?.[bot.botId] ?? bot.exposure,
      });
      made += 1;
    }
    if (
      teamRules &&
      !(await teamRules.teamRules()).some((rule) =>
        isSwitchRule(rule, input.appId),
      )
    ) {
      await teamRules.createTeamRule(input.by, {
        botId: "*",
        toolRef: `${input.appId}/*`,
        effect: "write",
        scope: input.appId,
        behaviour: "ask",
      });
      made += 1;
    }
    return made;
  }

  async function switchMode(input: {
    serverId: string;
    mode: AccountMode;
    by: string;
    confirm: boolean;
    approvals?: Record<string, SharedUseApproval>;
  }): Promise<AccountModeResult> {
    /*
     * THE APP, NOT THE DIALLED ROW. Several rows may name one app, and the gate reads the mode and
     * the approvals off the answering row alone — so a switch dialled through a duplicate writes
     * there, keys approvals there and names its rule after it, or it would be a switch nobody reads.
     */
    const appId = await sharedUse.appIdOf(input.serverId);
    const planned = await preview(appId, input.mode);
    if (!input.confirm) return { changed: false, preview: planned };

    /*
     * ALREADY IN THAT MODE IS A SWITCH ALREADY MADE — but not necessarily a switch FINISHED. Going on
     * would end accounts the CURRENT mode does not hold, and for a Shared app mint a fresh identity
     * over the one its connected account was made under. So nothing is minted or revoked here.
     *
     * WHAT THE MODE STANDS ON IS STILL MADE TO EXIST. A switch that failed between its steps, or an
     * install from before they were ordered, can leave a Shared app with no ask-before-write rule —
     * writes through the team account would then run without asking, and returning `changed` here
     * would make that permanent. So a Shared app gets any missing approval and its rule, and a
     * Personal one loses any approval or switch rule a half-finished switch back left standing.
     */
    if ((await store.serverAddress(appId))?.accountMode === input.mode) {
      if (input.mode === "shared") {
        const repaired = await ensureShared({
          appId,
          bots: planned.bots,
          approvals: input.approvals,
          by: input.by,
          overwrite: false,
        });
        if (repaired > 0) {
          await recordAuditEvent(deps.audit, {
            eventType: "mcp.account_mode_changed",
            targetType: "mcp_server",
            targetId: appId,
            actorUserId: input.by,
            payload: { server: appId, mode: input.mode, repaired },
          });
        }
      } else {
        await sharedUse.deleteApprovalsFor(appId);
        await forgetRule(appId, input.by);
      }
      return { changed: true, revoked: 0 };
    }

    const on = await store.accountsOn(appId);
    if (!on) throw new Error(`${input.serverId} is not a brokered app.`);
    const leaving = on.accounts.filter(
      (account) => account.holder === planned.wouldRevoke.holder,
    );
    const failures: { account: string; error: string }[] = [];
    for (const account of leaving) {
      try {
        await store.disconnectBrokered({
          toolkit: on.toolkit,
          account,
          by: input.by,
          reason: "mode_switched",
        });
      } catch (error) {
        failures.push({
          account: account.vendorUserId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (failures.length > 0) return { changed: false, failures };

    /*
     * ORDERED SO A FAILURE BETWEEN STEPS FAILS SAFE. Shared: the approvals and the ask-before-write
     * rule exist BEFORE the mode says shared, so there is no moment, and no half-finished switch,
     * in which the team account is in use without them; a failure leaves a Personal app that asks
     * more than it needs to, and the retry finishes. Personal: the mode stops shared use FIRST and
     * the tidying follows, because removing the rule first would leave a Shared app writing
     * unasked; a failure there is repaired by the retry above.
     */
    if (input.mode === "shared") {
      await ensureShared({
        appId,
        bots: planned.bots,
        approvals: input.approvals,
        by: input.by,
        overwrite: true,
      });
      await store.setAccountModeColumns(
        appId,
        "shared",
        mintDeploymentVendorUserId(deps.deploymentId),
      );
    } else {
      await store.setAccountModeColumns(appId, "personal", null);
      await sharedUse.deleteApprovalsFor(appId);
      await forgetRule(appId, input.by);
    }
    await recordAuditEvent(deps.audit, {
      eventType: "mcp.account_mode_changed",
      targetType: "mcp_server",
      targetId: appId,
      actorUserId: input.by,
      payload: {
        server: appId,
        mode: input.mode,
        revoked: leaving.length,
        bots: planned.bots.length,
      },
    });
    return { changed: true, revoked: leaving.length };
  }

  return { switchMode, forgetRule };
}

export type AccountModeSwitch = ReturnType<typeof createAccountModeSwitch>;

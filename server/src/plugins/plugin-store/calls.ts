import { connectAppRefusal } from "@openbot/shared/connect-prompt";
import { and, eq } from "drizzle-orm";
import { currentApprovalContext } from "../../approvals/types";
import { type AuditInitiator, recordAuditEvent } from "../../audit";
import {
  evaluateActionPolicy,
  type PolicyContext,
  policyInitiator,
} from "../../computer/policy";
import { withoutStatement } from "../../db/query-failure";
import {
  brokeredConnections,
  mcpTools,
  pluginGrants,
  vendorNameOf,
} from "../../db/schema";
import { classifyTool, tokenHeaderFor } from "../catalogue";
import { VERSION_ARG } from "../composio";
import { inspectToolArguments } from "../content-governance";
import { shareTargetOf } from "../share-target";
import type { AccountMode } from "../shared-accounts";
import { transportFor } from "../transport";
import type { StoreContext } from "./context";
import {
  effectiveUrl,
  type PluginDecision,
  type PluginKind,
  PluginRefusedError,
  reachedAsFor,
  toolNameFor,
  UNATTRIBUTED_ACTOR,
  withoutEmptyOptionals,
} from "./model";

/** Deciding whether a Bot may call a tool, and calling it. */
export function callMethods(context: StoreContext) {
  const {
    options,
    database,
    auditStore,
    injectedVendor,
    connectionTokenFor,
    requireServer,
    brokerProvider,
  } = context;
  return {
    /**
     * May this Bot use this plugin?
     *
     * The single question every caller asks, so there is one place the answer is decided and one
     * place to audit it. A missing row is a refusal, not an oversight.
     */
    async decide(
      kind: PluginKind,
      ref: string,
      agentId: string,
    ): Promise<PluginDecision> {
      const [row] = await database
        .select()
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, kind),
            eq(pluginGrants.ref, ref),
            eq(pluginGrants.agentId, agentId),
          ),
        )
        .limit(1);

      if (!row) {
        return {
          allowed: false,
          reason:
            kind === "mcp"
              ? `This Bot has not been given the tool ${ref}.`
              : `This Bot has not been given the skill ${ref}.`,
        };
      }
      return { allowed: true };
    },

    /**
     * Call a tool on somebody else's server, on a Bot's behalf.
     *
     * Decide, record, then act, which is the order the computer gateway uses and for the same
     * reason: a call that was permitted and then failed is exactly what an investigation needs to
     * see, and a trail written only on success cannot show it. The grant is checked first because a
     * tool this Bot was never given should not reach the policy engine, the vault or the network.
     */
    async callTool(input: {
      ref: string;
      args: Record<string, unknown>;
      botId: string;
      actorId: string;
      initiator?: AuditInitiator;
      /**
       * Whose connected account the call goes out on, when that is not the asker's: a Team Bot
       * reaching its owner's account (team-bots/team-bots.ts). Every gate is still the asker's.
       */
      credentialActorId?: string;
    }): Promise<{ text: string; isError: boolean }> {
      const [serverId, ...rest] = input.ref.split("/");
      const toolName = rest.join("/");
      if (!serverId || !toolName) {
        throw new PluginRefusedError(`${input.ref} is not a tool.`, null);
      }

      /*
       * Who the trail says made this call, which is not what the call is made AS.
       *
       * `input.actorId` stays the value every gate is decided on, and the empty string must go on
       * matching no grant and no connection anywhere. This is only what the row says: a run nobody
       * could be attributed to is `unattributed` rather than blank, on the criterion at
       * {@link DEPLOYMENT_ACTOR}, and never `deployment` — a run this deployment could not put a
       * name to is not the deployment having acted.
       */
      const auditActor = input.actorId || UNATTRIBUTED_ACTOR;

      const decision = await this.decide("mcp", input.ref, input.botId);
      if (!decision.allowed) {
        await recordAuditEvent(auditStore, {
          eventType: "mcp.call_rejected",
          targetType: "mcp_tool",
          targetId: input.ref,
          ...(input.initiator ? { initiator: input.initiator } : {}),
          payload: {
            actor: auditActor,
            bot: input.botId,
            server: serverId,
            tool: toolName,
            refusal: "not_granted",
            reason: decision.reason,
          },
        });
        throw new PluginRefusedError(decision.reason, null);
      }

      const { row, entry, access, app } = await requireServer(serverId);

      const advertised = await database
        .select({
          name: mcpTools.name,
          vendorName: vendorNameOf(),
          inputSchema: mcpTools.inputSchema,
          effect: mcpTools.effect,
          destructive: mcpTools.destructive,
          version: mcpTools.version,
        })
        .from(mcpTools)
        .where(
          and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)),
        )
        .limit(1);

      const effect = classifyTool(
        entry,
        toolName,
        advertised.length > 0,
        advertised[0]?.effect,
      );

      const args = withoutEmptyOptionals(
        input.args,
        advertised[0]?.inputSchema as Record<string, unknown> | undefined,
      );

      /*
       * The version this action was listed at, handed to the transport that needs one.
       *
       * Under a reserved key rather than as a parameter on the shared signature, because that
       * signature is MCP's and three other transports implement it. The Composio transport strips
       * the key before anything reaches the vendor, and asserts that it did.
       *
       * A `__version` in the model's own arguments is not an argument: it is this key, and no
       * vendor publishes it. So it is stripped unconditionally, whatever its value, and that strip
       * is the whole protection. The recorded version is then merged into arguments that provably
       * cannot carry the key, which makes both spread orders identical: the merge order has no
       * reachable failure mode. Do not read the strip as belt-and-braces on top of an ordering
       * guarantee — the ordering is the redundant half, and removing the strip is what would let a
       * model choose which revision of an action runs.
       *
       * Absent when the app has not been refreshed since the column existed, and because the key
       * was stripped there is then no version at all for the transport to read, which is what makes
       * its refusal hold rather than guessing — a guessed version is a call against an action's
       * other behaviour.
       */
      const { [VERSION_ARG]: _dropped, ...modelArgs } = args;
      const vendorArgs = advertised[0]?.version
        ? { ...modelArgs, [VERSION_ARG]: advertised[0].version }
        : modelArgs;

      /**
       * The same policy the computer actions are judged by, asked about a tool call.
       *
       * Every field is present, including the ones a tool call has no use for, and that is load
       * bearing rather than tidy. This engine treats an expression it cannot evaluate as a match,
       * which is correct for a browser action on an element the server could not resolve. Applied to
       * a tool call it is a disaster: the boundary this product ships in `.env.example` denies
       * `contains(element.name, "submit") || key == "Enter"`, and with `element` and `key` absent
       * that rule is unevaluable, so it would match, so every deployment using the shipped preset
       * would refuse every MCP call for a reason mentioning a submit button.
       *
       * Neutral values instead. Empty strings match no substring, no key and no extension, so a rule
       * written about the browser evaluates to false against a tool call, which is the honest answer:
       * a tool call did not click anything. A rule meant to catch tool calls says so, with `mcp` or
       * with `intent`.
       */
      const context: PolicyContext = {
        tool: { name: toolNameFor(input.ref) },
        bot: { id: input.botId },
        actor: { id: input.actorId },
        page: { url: "", host: "" },
        element: { ref: "", role: "", name: "", type: "" },
        key: "",
        file: { path: "", name: "", extension: "" },
        // Empty, like the browser fields above: an MCP call runs no shell command, but a
        // `deny: contains(command, "rm -rf")` names `command`, and an unbound identifier throws and
        // fails closed — which would refuse every MCP call once a deployment wrote a rule about its
        // shell. An empty command matches no such rule.
        command: "",
        intent: effect === "write" ? "write_tool" : "read_tool",
        mcp: { server: serverId, tool: toolName, effect },
        /*
         * The real one, and this is the path where it is not neutral. A routine's turn reaches its
         * tools through here, carrying the initiator its run assertion was signed with, so this is
         * where `initiator.kind == "routine"` becomes a rule a deployment can actually write. A
         * chat turn arrives with none and reads as a person.
         */
        initiator: policyInitiator(input.initiator),
      };

      const verdict = evaluateActionPolicy(options.policy(), context);

      /*
       * The parts of the row that are known before the attempt, held rather than written.
       *
       * Everything here is a fact about the decision, and the decision is final at this point. What
       * is NOT yet known is whether the call worked, which is why this is a variable and not a write:
       * the row goes down once, after the outcome exists.
       */
      const decided = {
        actor: auditActor,
        bot: input.botId,
        server: serverId,
        tool: toolName,
        effect,
        /*
         * Whose credential this call goes out with.
         *
         * Without it the trail cannot answer "who did this run reach as", which is the whole question
         * a per-person connector raises — two rows for the same tool and the same Bot can legitimately
         * have seen entirely different documents, and nothing else in the row says why.
         */
        reachedAs: reachedAsFor(
          access,
          input.credentialActorId ?? input.actorId,
        ),
        decision: {
          allowed: verdict.allowed,
          mode: verdict.mode,
          rule: verdict.matched,
          source: verdict.source,
          carriedOut: verdict.forward,
        },
      };

      /*
       * A refusal is written on the POLICY's answer, not on whether the call was then let through.
       *
       * This deployment declining is the whole event, and it is recorded before the throw so that a
       * refusal cannot be lost by the caller's error handling.
       *
       * In `dry-run` the policy still refuses and the mode forwards anyway, which is the whole point
       * of the mode: `evaluateActionPolicy` returns `allowed: false` with `forward: true` so a rule
       * can be tried against live traffic before it starts refusing anybody. Writing this row on
       * `forward` therefore recorded nothing at all on this surface for exactly the traffic an
       * operator switched dry-run on to measure — the browser gateway keys its row on
       * `decision.allowed` and does record it — so `Blocked` on the audit page, and every
       * `eventType=mcp.call_rejected` query behind it, answered "this rule would refuse none of your
       * tool calls" about calls it would refuse. The rule then looked inert, and enforcing it
       * started refusing Bots with no warning in the trail.
       *
       * `decision.carriedOut` is what tells the two rows apart: false is a call this deployment
       * stopped, true is one dry-run recorded and let past. The outcome row below is unchanged, so a
       * forwarded call still says separately whether the vendor answered.
       */
      if (!verdict.allowed) {
        await recordAuditEvent(auditStore, {
          eventType: "mcp.call_rejected",
          targetType: "mcp_tool",
          targetId: input.ref,
          ...(input.initiator ? { initiator: input.initiator } : {}),
          payload: decided,
        });
      }
      if (!verdict.forward) {
        throw new PluginRefusedError(verdict.reason, verdict.matched);
      }

      /**
       * Structural policy answers whether this Bot may call this tool. Content inspection answers
       * whether the arguments would carry a credential out of the deployment. It runs after policy
       * and before credentials are read or a vendor is contacted, and its result contains paths and
       * categories only: never the values it refused.
       *
       * IT IS ASKED ABOUT WHAT WOULD BE SENT, WHICH IS `vendorArgs` AND NOT `args`.
       *
       * CRITERION. The object this inspection judges is the object handed to the transport below,
       * identically — not a version of it taken before the reserved key was stripped and the
       * recorded one merged in.
       *
       * REASON. It was asked about `args`, so the gate and the call were about two different
       * objects, and they came apart in both directions. Whatever is merged in below the strip left
       * this deployment WITHOUT HAVING BEEN LOOKED AT, which is not a boundary at all — it is a
       * boundary around a neighbouring value. And the reserved key, which is stripped
       * unconditionally and provably reaches no vendor, was still judged: a model that put anything
       * credential-shaped under `__version` had its granted call refused and its person told the
       * arguments carry credential material, over material that was never going anywhere and a
       * refusal no rule of this deployment's asked for.
       */
      const contentDecision = inspectToolArguments(vendorArgs);
      if (!contentDecision.safe) {
        await recordAuditEvent(auditStore, {
          eventType: "mcp.call_rejected",
          targetType: "mcp_tool",
          targetId: input.ref,
          ...(input.initiator ? { initiator: input.initiator } : {}),
          payload: {
            ...decided,
            decision: { ...decided.decision, carriedOut: false },
            refusal: "sensitive_tool_arguments",
            contentInspection: {
              reason: contentDecision.reason,
              findings: contentDecision.findings,
            },
          },
        });
        throw new PluginRefusedError(
          contentDecision.reason === "sensitive_content"
            ? "The tool call was refused because its arguments contain a password or key."
            : "The tool call was refused because its arguments could not be inspected safely.",
          null,
        );
      }

      /*
       * A write that sends content to other people asks the owner first, whatever their general
       * approvals switch says. Pending throws the check's own wait, which a headless turn and the
       * open chat both turn into a paused tool call; denied is a refusal like any other.
       */
      const share =
        effect === "write" && options.privateShareCheck
          ? shareTargetOf(serverId, toolName, vendorArgs)
          : null;
      if (share && options.privateShareCheck) {
        const shareVerdict = await options.privateShareCheck({
          ownerUserId: input.actorId,
          botId: input.botId,
          audience: share.audience,
          content: share.content,
          origin: { kind: "unknown" },
        });
        if (shareVerdict.status !== "allowed") {
          await recordAuditEvent(auditStore, {
            eventType: "mcp.call_rejected",
            targetType: "mcp_tool",
            targetId: input.ref,
            ...(input.initiator ? { initiator: input.initiator } : {}),
            payload: {
              ...decided,
              decision: { ...decided.decision, carriedOut: false },
              refusal:
                shareVerdict.status === "pending"
                  ? "private_share_pending"
                  : "private_share_denied",
            },
          });
          // A pending share outside any run that can wait says so and sends nothing.
          if (shareVerdict.status === "pending" && currentApprovalContext())
            throw shareVerdict.suspension;
          throw new PluginRefusedError(shareVerdict.message, null);
        }
      }

      /*
       * A SHARED ACCOUNT ANSWERS TO WHOEVER CAN STEER THE BOT, and that is checked on every call.
       *
       * The grant says this Bot may use the app; it says nothing about who may reach the Bot. A
       * Shared app acts as one team account for everyone, so a Bot opened to more people than an
       * administrator approved would hand that account to all of them. The gate decides that here,
       * at call time, so an audience widened a moment ago is caught on its next call. With no gate
       * wired there is nothing that can answer the question, and the call is refused rather than
       * assumed safe.
       */
      /*
       * DECIDED ON, AND KEYED BY, THE APP'S ANSWERING ROW — never the dialled one. A duplicate row
       * at a Shared app's url saying `personal` must not take the call round this gate, and an
       * approval is a fact about the app, so it is asked for under the app's id whichever row the
       * grant happens to name. `gatedMode` then travels to {@link connectionTokenFor}, which
       * refuses if the account it resolves is not the one this gate was decided about.
       */
      const gatedMode: AccountMode | null =
        access.credential !== "brokered"
          ? null
          : app?.accountMode === "shared"
            ? "shared"
            : "personal";
      if (gatedMode === "shared" && app) {
        const verdict = options.sharedUse
          ? await options.sharedUse({
              botId: input.botId,
              serverId: app.id,
              title: row.title,
              actorId: input.actorId,
              ...(input.initiator ? { initiator: input.initiator } : {}),
            })
          : {
              allowed: false as const,
              message: `${row.title} is shared, and OpenBot can't check who may use it, so it wasn't called.`,
            };
        if (!verdict.allowed) {
          await recordAuditEvent(auditStore, {
            eventType: "mcp.call_rejected",
            targetType: "mcp_tool",
            targetId: input.ref,
            ...(input.initiator ? { initiator: input.initiator } : {}),
            payload: {
              ...decided,
              decision: { ...decided.decision, carriedOut: false },
              refusal: verdict.refusal ?? "shared_audience",
            },
          });
          throw new PluginRefusedError(verdict.message, null);
        }
      }

      /*
       * THE APPROVAL GATE IS ASKED UNDER THE APP'S ID TOO, for a brokered row whose app has an
       * answering row. Rules are written against the app — the Shared default is `${appId}/*`
       * scoped to the app's id — so a write granted through a duplicate row has to be judged as
       * the app's, or it matches no rule and walks past the ask an administrator set. `target`
       * still names the dialled row, which is what the call itself goes to; every other row is
       * asked about exactly as before.
       */
      const gateApp = access.credential === "brokered" ? app : null;
      const approval = await options.approvalGate?.({
        actorId: input.actorId,
        botId: input.botId,
        toolRef: gateApp ? `${gateApp.id}/${toolName}` : input.ref,
        effect,
        scope: gateApp ? gateApp.id : serverId,
        args: vendorArgs,
        target: { serverId, toolName, url: row.url, effect },
        continuation: currentApprovalContext(),
      });
      if (approval && "replay" in approval)
        return approval.replay as { text: string; isError: boolean };

      /*
       * Attempt first, record second.
       *
       * The row now says what HAPPENED rather than what was permitted. It used to be written here,
       * before the two lines below, which meant a call that died at the vendor left `call_succeeded`
       * behind it — and a per-person connector fails at exactly these two lines: no connection for
       * the asker, a refresh token the vendor no longer accepts, an API not enabled for the project.
       * Every one of those was invisible, and worse than invisible, because the trail asserted the
       * opposite.
       *
       * `isError` counts as a failure. A vendor that answers the protocol correctly to say the tool
       * itself failed has not completed the call, and a reader counting successes should not be told
       * it did.
       */
      try {
        const { token, vendorUserId } = await connectionTokenFor(
          row,
          entry,
          input.credentialActorId ?? input.actorId,
          access,
          gatedMode,
        );
        const vendor =
          injectedVendor ?? transportFor(access.transport).callTool;
        const result = await vendor(
          {
            url: effectiveUrl(row, entry),
            token,
            tokenHeader: tokenHeaderFor(entry),
            actorId: vendorUserId ?? input.credentialActorId ?? input.actorId,
            botId: input.botId,
          },
          /*
           * THE NAME THE VENDOR KNOWS, WHICH IS THE ONLY ONE IT WILL ANSWER TO. `toolName` is this
           * deployment's half of the ref and is what the model was offered; Arcade is called by the
           * qualified name its listing gave. They are the same string for every other transport,
           * which is what the fallback records rather than papers over — see
           * {@link mcpTools.vendorName}.
           *
           * FALLING BACK TO `toolName` RATHER THAN REFUSING, because a row this read did not find
           * is not an unknown action: `classifyTool` above is built to decide on an app whose
           * listing predates its catalogue entry, and the call goes on to the vendor to be judged
           * there. The fallback is reached only for an action with no recorded row at all, and for
           * those two names were never distinct.
           */
          advertised[0]?.vendorName ?? toolName,
          vendorArgs,
        );
        await recordAuditEvent(auditStore, {
          eventType: result.isError ? "mcp.call_failed" : "mcp.call_succeeded",
          targetType: "mcp_tool",
          targetId: input.ref,
          ...(input.initiator ? { initiator: input.initiator } : {}),
          /*
           * The vendor's own words, when it is reporting a failure.
           *
           * Only on the failure branch, and this is the whole point of the distinction. A successful
           * result is somebody's data — a file listing, a document — and it has no business in an
           * audit row that an administrator can read. An `isError` result is a message written for
           * whoever operates this deployment, and it is the most useful sentence available: Google
           * refuses the Drive MCP server with "The caller does not have permission", which named the
           * problem after a generic message had already cost a round of probing.
           *
           * Capped, because the failure branch is not a promise about length.
           */
          payload: result.isError
            ? {
                ...decided,
                failure:
                  result.text.slice(0, 400) || "the tool reported an error",
              }
            : decided,
        });
        const answer = { text: result.text, isError: result.isError };
        await approval?.complete(answer);
        /*
         * The one answer that leaves this block without returning: see below the catch. Thrown
         * from in here, the catch would write a second `mcp.call_failed` row about the same call.
         */
        if (!result.accountGone) return answer;
      } catch (error) {
        /*
         * Recorded, then rethrown unchanged. The caller's behaviour is unaffected — what changes is
         * that the failure now exists in the trail, which is where somebody asking "is this connector
         * working" looks. The vendor's own sentence is kept, since for a 403 that is the sentence
         * naming which API is not enabled.
         *
         * Capped like the `isError` branch above, and for the same reason: parts of this sentence
         * came from the vendor, and a failure is not a promise about length.
         */
        await recordAuditEvent(auditStore, {
          eventType: "mcp.call_failed",
          targetType: "mcp_tool",
          targetId: input.ref,
          ...(input.initiator ? { initiator: input.initiator } : {}),
          payload: {
            ...decided,
            /*
             * Asked through {@link withoutStatement}, because not every throw in this block is a
             * vendor's sentence.
             *
             * The vendor's own words are what this field is for and are kept. But every query on
             * the way here throws a `DrizzleQueryError` whose message is our statement and its
             * bound values — credential ids, user ids, server ids — and `audit_events` is read by
             * an operator and exported. A dump in the row that records a failed call is the same
             * disclosure the tool-list replace was fixed for, in the trail rather than on a page.
             */
            failure: (error instanceof Error
              ? withoutStatement(error)
              : String(error)
            ).slice(0, 400),
          },
        });
        throw error;
      }
      /*
       * THE ACCOUNT IS GONE AT THE VENDOR, AND THE PERSON CAN PUT IT BACK FROM WHERE THEY ARE. The
       * only way here: every other answer returned inside the block and every throw left the catch.
       *
       * Recorded above as the failure it is, with the vendor's condition in the trail. Handed on as
       * a refusal carrying an app card rather than as the vendor's error, because nothing on this
       * deployment's rows knows the account is gone — the app reads as ready on every screen — and
       * the card is the one place the person is told, with Reconnect beside it. A Shared app's
       * account is the deployment's, so there the card says an administrator has to reconnect it.
       *
       * AND THE ROW GOES, as it does when a confirm hears the same no from the vendor: the row is
       * only the vendor's last answer, and one that outlived the account would go on reading
       * `ready` on every screen — `show_app_access` telling the model to use the app straight after
       * this card — and would make the connect route refuse a fresh connection until somebody
       * found Disconnect. Deleted, the app reads not connected for the person, or the team account
       * not connected for everybody, which is the truth and the state whose button fixes it. Like
       * the confirm's, the delete files no trail entry: nobody disconnected anything here.
       */
      if (access.credential === "brokered" && access.toolkit)
        await database
          .delete(brokeredConnections)
          .where(
            gatedMode === "shared"
              ? and(
                  eq(brokeredConnections.provider, brokerProvider),
                  eq(brokeredConnections.app, access.toolkit),
                  eq(brokeredConnections.holder, "deployment"),
                )
              : and(
                  eq(brokeredConnections.provider, brokerProvider),
                  eq(brokeredConnections.app, access.toolkit),
                  eq(brokeredConnections.holder, "person"),
                  eq(
                    brokeredConnections.userId,
                    input.credentialActorId ?? input.actorId,
                  ),
                ),
          );
      throw new PluginRefusedError(
        connectAppRefusal({
          serverId: row.id,
          title: row.title,
          message:
            gatedMode === "shared"
              ? `The shared ${row.title} account is no longer connected, so this wasn't done. Ask an admin to reconnect it.`
              : `Your ${row.title} account is no longer connected, so this wasn't done. Reconnect it and ask again.`,
          reason: gatedMode === "shared" ? "shared" : "reconnect",
          at: new Date().toISOString(),
        }),
        null,
      );
    },
  };
}

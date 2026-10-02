import { z } from "zod";
import type { RunAssertion } from "../agents/callback-token";
import type { AuditInitiator } from "../audit";
import type { HeadlessTool } from "../computer/headless-tools";
import { PluginRefusedError } from "../plugins/store";
import type { GrantedTool } from "../plugins/tools";
import { isApprovalRecheck } from "./service";
import {
  type ApprovalAction,
  type ApprovalCandidate,
  type ApprovalContinuation,
  ApprovalRefusedError,
  parseApprovalContinuation,
} from "./types";

/** What carrying out an approved action needs from the deployment. Injected so it can be tested. */
export type ApprovedActionDependencies = {
  /** The conversation the action came from, if this Bot and person can still reach it. */
  sourceFor(run: {
    actorId: string;
    botId: string;
    threadId: string;
    runId: string;
    depth: number;
    initiator: AuditInitiator;
  }): Promise<unknown>;
  gate(candidate: ApprovalCandidate): Promise<unknown>;
  computerTools(
    actorId: string,
    botId: string,
    initiator: AuditInitiator,
  ): Promise<HeadlessTool[]>;
  hostTools(input: {
    actorId: string;
    botId: string;
    initiator: AuditInitiator;
  }): GrantedTool[];
  callTool(input: {
    ref: string;
    args: Record<string, unknown>;
    botId: string;
    actorId: string;
    initiator: AuditInitiator;
    credentialActorId?: string;
  }): Promise<{ text: string; isError: boolean }>;
  /**
   * Whose connected account a call goes out on: the live call path's rule (a Team Bot reaches its
   * owner's account, a teammate's own only with consent), applied again here so an approved call
   * does not go out on the approver's own account instead.
   */
  credentialActorFor(
    actorId: string,
    botId: string,
    ref: string,
  ): Promise<string>;
  /** A hand-off or question tool (`bot/...`), run as the coordination tools run it live. */
  coordinationCall(input: {
    name: string;
    args: Record<string, unknown>;
    run: RunAssertion;
  }): Promise<{ text: string; isError: boolean } | null>;
  /** The signed run carried in the continuation, so a resumed hand-off keeps its original depth. */
  readRun?(forwardedProps: unknown): RunAssertion | null;
  answer(result: { text: string; isError: boolean }): string;
  privateShareToolRef: string;
  refusalMarker: string;
  personInitiator: AuditInitiator;
};

/**
 * Carry out one approved action as its own tool would have, so the action's own gate sees the
 * approval and lets it through. Also run under `validateReentry`, where that gate reports the action
 * it would have asked about instead of acting.
 */
export function createApprovedActionExecutor(deps: ApprovedActionDependencies) {
  return async (action: ApprovalAction): Promise<unknown> => {
    const snapshot: ApprovalContinuation = parseApprovalContinuation(
      action.continuation,
    );
    const initiator = snapshot.initiator ?? deps.personInitiator;
    const source = await deps.sourceFor({
      actorId: action.actorId,
      botId: action.botId,
      threadId: action.threadId,
      runId: action.runId,
      depth: 0,
      initiator,
    });
    if (!source)
      throw new ApprovalRefusedError(
        "That conversation is no longer available to this Bot and person.",
      );
    // A private-information share the person allowed: the approval is the whole action, and the Bot
    // is told to send again, which the share check then passes. Gated so re-entry validation sees it.
    if (action.toolRef === deps.privateShareToolRef) {
      await deps.gate({
        actorId: action.actorId,
        botId: action.botId,
        toolRef: action.toolRef,
        effect: action.effect,
        scope: action.scope,
        args: action.args,
        target: action.target,
        continuation: snapshot,
      });
      return "The person allowed this share. Send it again now, unchanged.";
    }
    const computer = await deps.computerTools(
      action.actorId,
      action.botId,
      initiator,
    );
    if (snapshot.toolName.startsWith("computer_")) {
      const tool = computer.find(
        (tool) => tool.definition.name === snapshot.toolName,
      );
      if (!tool)
        throw new ApprovalRefusedError(
          "That computer tool is no longer available.",
        );
      return tool.execute(snapshot.args, {
        toolCallId: snapshot.toolCallId,
        signal: new AbortController().signal,
      });
    }
    if (snapshot.toolName.startsWith("host_")) {
      const tool = deps
        .hostTools({ actorId: action.actorId, botId: action.botId, initiator })
        .find((tool) => tool.name === snapshot.toolName);
      if (!tool)
        throw new ApprovalRefusedError(
          "That host tool is no longer available.",
        );
      const result = await tool.execute(snapshot.args);
      if (result.startsWith(deps.refusalMarker))
        throw new ApprovalRefusedError(result);
      return result;
    }
    const args = z.record(z.string(), z.unknown()).parse(snapshot.args);
    // A hand-off is not a connector call: sent to the connector path, it was refused as not
    // granted, so "Allow once" on a hand-off could never be carried out.
    if (action.toolRef.startsWith("bot/")) {
      const forwarded = snapshot.forwardedProps;
      const signed =
        forwarded && typeof forwarded === "object" && "openbotRun" in forwarded
          ? (deps.readRun?.(forwarded.openbotRun) ?? null)
          : null;
      const run: RunAssertion =
        signed &&
        signed.actorId === action.actorId &&
        signed.botId === action.botId
          ? signed
          : {
              actorId: action.actorId,
              botId: action.botId,
              runId: action.runId,
              threadId: action.threadId,
              depth: 0,
              initiator,
            };
      const answered = await deps.coordinationCall({
        name: snapshot.toolName,
        args,
        run,
      });
      if (!answered)
        throw new ApprovalRefusedError(
          "That coordination tool is no longer available.",
        );
      if (answered.isError) throw new ApprovalRefusedError(answered.text);
      return answered.text;
    }
    // A refused call (the grant was removed, a teammate's consent is missing) is an answer for the
    // Bot. Left as the connector's own error, the approval sweep retried it until it gave up.
    let result: { text: string; isError: boolean };
    try {
      // The re-check stops at the gate before the call is made, so it must not resolve the account:
      // that spends a teammate's one-time consent, and the real run would then be refused.
      const credentialActorId = isApprovalRecheck()
        ? action.actorId
        : await deps.credentialActorFor(
            action.actorId,
            action.botId,
            action.toolRef,
          );
      result = await deps.callTool({
        ref: action.toolRef,
        args,
        botId: action.botId,
        actorId: action.actorId,
        initiator,
        ...(credentialActorId === action.actorId ? {} : { credentialActorId }),
      });
    } catch (error) {
      if (error instanceof PluginRefusedError)
        throw new ApprovalRefusedError(error.message);
      throw error;
    }
    if (result.isError) throw new Error(result.text);
    return deps.answer(result);
  };
}

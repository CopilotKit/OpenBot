import type { TurnAdmission } from "@openbot/toolkit/ports";
import { headlessTurnRefusal } from "../admin/controls";
import { guardBotTurn } from "./lifecycle";

/**
 * The server's admission for a headless turn: the pause guard, then the enterprise controls.
 *
 * In that order, as the turn runner has always taken them. Both read state this process installs at
 * startup (`configureBotLifecycle`, the enterprise controls), which is why they live here rather than
 * in the turn code.
 */
export const serverTurnAdmission: TurnAdmission = async ({
  ownerUserId,
  agentId,
  signal,
}) => {
  // Paused Bots do not start; a pause while running aborts this signal. See agents/lifecycle.ts.
  const admitted = await guardBotTurn({ ownerUserId, agentId, signal });
  // "Use Bots" and the model allowlist, which a browser run meets at the HTTP gate. No headless turn
  // crosses that gate, so every one of them meets the same check here instead.
  const refused = await headlessTurnRefusal({ ownerUserId, agentId });
  if (refused) {
    const error = new Error(refused);
    error.name = "CapabilityRefusedError";
    throw error;
  }
  return admitted;
};

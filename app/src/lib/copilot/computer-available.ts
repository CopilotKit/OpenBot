import { useQuery } from "@tanstack/react-query";
import { agentQueryOptions } from "@/lib/agents/queries";
import {
  type CapabilityKey,
  myCapabilitiesQueryOptions,
} from "@/lib/enterprise/queries";
import { useDeclaredBotId } from "./active-bot";

/** Which computer tools this conversation offers the Bot. */
export type ComputerToolsOffered = {
  /** Acting on the page that is open: reading it, clicking, typing, scrolling. */
  browser: boolean;
  /** Opening a page, which is the browser plus the network. */
  navigate: boolean;
  /** The computer behind the screen: its files and its shell. */
  computer: boolean;
};

/**
 * Whether this chat may use the Bot's computer, and which parts of it.
 *
 * TWO QUESTIONS, NOT ONE. The first is whose computer it is: the computer carries its owner's
 * signed-in browser, and these tools run from this browser on the person's own session, so the
 * server refuses every computer route (and every sign-in into it) to a Team Bot's teammates. The
 * second is what the deployment allows anybody at all — the capability switches an administrator
 * set, which the computer boundary enforces on every `computer_*` call in `decideFromSnapshot`.
 *
 * MIRRORING THAT SERVER-SIDE SPLIT IS THE POINT, and it is a split by intent rather than by tool:
 * files and commands need `cloudComputer`, everything else on the computer needs `cloudBrowser`,
 * and opening a page needs `cloudNetwork` on top. A Bot offered a tool whose capability is off does
 * not fail safe into silence — it reaches for the tool, gets a refusal, and spends the turn saying
 * so, which is how asking a Bot a question about an app it holds no tools for ended with its screen
 * opening on nothing.
 *
 * Pure, and separated from the hook below, because every one of those rules is worth stating in a
 * test without a router, a query client and a profile fetch around it.
 */
export function computerToolsOffered({
  profile,
  capabilities,
}: {
  /** Undefined while it loads: the server is the one that decides, so unresolved offers. */
  profile: { visibility: string; canManage: boolean } | undefined;
  capabilities: Partial<Record<CapabilityKey, boolean>> | undefined;
}): ComputerToolsOffered {
  const mine = !profile || profile.visibility === "public" || profile.canManage;
  // An unresolved switch reads as allowed, for the same reason an unresolved profile does.
  const allows = (capability: CapabilityKey) =>
    capabilities?.[capability] !== false;
  const browser = mine && allows("cloudBrowser");
  return {
    browser,
    navigate: browser && allows("cloudNetwork"),
    computer: mine && allows("cloudComputer"),
  };
}

/**
 * Whether this browser may drive the Bot's computer at all, capabilities aside.
 *
 * The first of the two questions above, on its own. `report_refusal` rides on it: recording that a
 * Bot declined something is audit bookkeeping rather than a computer action, so it stays offered
 * wherever the Bot is this person's to drive, whatever the computer switches say.
 */
export function useComputerAvailable(): boolean {
  const declared = useDeclaredBotId();
  const { data: profile } = useQuery({
    ...agentQueryOptions(declared ?? ""),
    enabled: Boolean(declared),
  });
  return !profile || profile.visibility === "public" || profile.canManage;
}

export function useComputerToolsOffered(): ComputerToolsOffered {
  const declared = useDeclaredBotId();
  const { data: profile } = useQuery({
    ...agentQueryOptions(declared ?? ""),
    enabled: Boolean(declared),
  });
  const { data: mine } = useQuery(myCapabilitiesQueryOptions());
  return computerToolsOffered({
    profile,
    capabilities: mine?.capabilities,
  });
}

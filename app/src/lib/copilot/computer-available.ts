import { useQuery } from "@tanstack/react-query";
import { agentQueryOptions } from "@/lib/agents/queries";
import { useDeclaredBotId } from "./active-bot";

/**
 * Whether this chat may use the Bot's computer: a public Bot, or one this person owns or administers.
 *
 * Not a Team Bot's teammates. The computer carries its owner's signed-in browser, and the computer
 * tools run from this browser on the person's own session, so the server refuses every computer
 * route (and every sign-in into it) to anyone else. True while the profile loads: the server is the
 * one that decides, and this only stops offering tools that would be refused.
 */
export function useComputerAvailable(): boolean {
  const declared = useDeclaredBotId();
  const { data: profile } = useQuery({
    ...agentQueryOptions(declared ?? ""),
    enabled: Boolean(declared),
  });
  return !profile || profile.visibility === "public" || profile.canManage;
}

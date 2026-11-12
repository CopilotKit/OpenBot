import { RoutinesList } from "@/components/routines/routines-list";
import { useMuse } from "../context";
import { MuseScreen } from "../ui";
import { NoBot } from "./activity";

/**
 * Routines: what the centre Bot keeps doing for the person. OpenBot's own Routines list, with its
 * routines, goals and check-ins in one list and every switch, Run now, history and Delete they
 * offer. The tab keeps its id, `goals`, so an old `/s/goals` link still opens it.
 */
export function GoalsScreen() {
  const { bot } = useMuse();
  return (
    <MuseScreen title="Routines">
      {bot ? <RoutinesList agentId={bot.id} embedded /> : <NoBot />}
    </MuseScreen>
  );
}

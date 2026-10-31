import { BotResponsibilities } from "@/components/responsibilities/responsibilities";
import { RoutinesList } from "@/components/routines/routines-list";
import { cn } from "@/lib/utils";
import { useMuse } from "../context";
import { Divider, MuseScreen, museText, StatusDot } from "../ui";
import { NoBot } from "./activity";

/**
 * Goals: what the centre Bot keeps doing for the person. OpenMuse's "Tracking" is OpenBot's routines,
 * and its "Goals" are OpenBot's responsibilities, which OpenBot itself titles Goals on a Bot's page.
 * Both lists are OpenBot's own, with every switch, Run now, history and Delete they offer.
 */
export function GoalsScreen() {
  const { bot } = useMuse();
  if (!bot) {
    return (
      <MuseScreen title="Goals">
        <NoBot />
      </MuseScreen>
    );
  }
  return (
    <MuseScreen title="Goals">
      <section>
        <div className="flex items-center gap-2.5">
          <StatusDot tone="green" />
          <h2
            className={cn(
              museText.heading,
              "text-[var(--openmuse-green-text)]",
            )}
          >
            Routines
          </h2>
        </div>
        <RoutinesList agentId={bot.id} embedded />
      </section>
      <Divider className="mt-8" />
      <div className="[&>section]:mt-6">
        <BotResponsibilities agentId={bot.id} />
      </div>
    </MuseScreen>
  );
}

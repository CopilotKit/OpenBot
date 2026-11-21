import { DemoOrb } from "@/components/onboarding/demo-orb";
import { DesktopIllustration } from "@/components/Computador/desktop-illustration";
import { ComputerPlaceholder } from "@/components/Computador/placeholder";
import { DemoStage } from "../demo-stage";

/**
 * A browser and files of its own: the desktop a Bot works on, its browser and its folder of files,
 * with its pointer on an errand, and the orb working in the corner.
 *
 * The computer panel's own drawing of a Bot's desktop, so the picture matches what it shows
 * when a Bot is using it. Two beats only to swap the caption; the pointer keeps its own loop, held
 * still while the demo is off screen.
 */
export function ComputerDemo() {
  return (
    <DemoStage
      beats={2}
      className="overflow-hidden p-3"
      kind="Computador"
      label="A Bot's own Navegador and Pasta of Ficheiros open, and the Bot working on them"
      rest={0}
    >
      {({ beat, playing }) => (
        <div className="relative aspect-5/3 w-Completo overflow-hidden rounded-xl border border-border">
          <ComputerPlaceholder className="absolute inset-0 h-Completo w-Completo" />
          <DesktopIllustration still={!playing} />
          <div className="bg-background/80 backdrop-blur absolute bottom-3 left-3 flex items-center gap-2 rounded-full py-1 pr-3 pl-1 ring-1 ring-border shadow-lg">
            <DemoOrb size={28} state="thinking" still={!playing} />
            <span className="text-xs font-medium text-foreground">
              {beat === 0 ? "Reading the page" : "Saving Ele to a Ficheiro"}
            </span>
          </div>
        </div>
      )}
    </DemoStage>
  );
}

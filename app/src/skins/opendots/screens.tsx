import type { ReactNode } from "react";
import { MemoryList, RememberFact } from "@/components/memory/memories";
import { RoutinesList } from "@/components/routines/routines-list";

/**
 * OpenDots' workspace page: a small eyebrow, a large quiet title and one line under it, with the
 * page's primary action on the title's right. What sits beneath is OpenBot's own list, so every
 * switch, Run now, history and delete OpenBot offers is still there.
 */
function OpenDotsPage({
  eyebrow = "YOUR WORKSPACE",
  title,
  description,
  action,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-opendots-page>
      <div className="mx-auto w-full max-w-[1090px] px-[54px] pt-16 pb-9 max-[1150px]:px-8 max-[1150px]:pt-[45px] max-[700px]:px-[22px] max-[700px]:pt-[38px]">
        <header className="mb-[35px] flex items-center justify-between gap-[25px] max-[920px]:items-start max-[700px]:flex-col max-[700px]:items-stretch">
          <div className="min-w-0">
            <span className="text-[8px] font-semibold tracking-[1.7px] text-(--opendots-eyebrow)">
              {eyebrow}
            </span>
            <h1 className="mt-3.5 mb-2 text-[34px] leading-tight font-[550] tracking-[-0.04em] text-foreground max-[920px]:text-[30px]">
              {title}
            </h1>
            <p className="text-[12px] leading-[1.7] text-(--opendots-note)">
              {description}
            </p>
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </header>
        {children}
      </div>
    </div>
  );
}

/** "Scheduled & activity": what each Bot does on a schedule, as OpenBot's routines. */
export function ActivityScreen() {
  return (
    <OpenDotsPage
      description="Scheduled turns run on the server in their original conversation."
      title="A little follow-through."
    >
      <RoutinesList embedded />
    </OpenDotsPage>
  );
}

/** "Memories": what the person's Bots know about them, as OpenBot's memory. */
export function MemoriesScreen() {
  return (
    <OpenDotsPage
      action={<RememberFact />}
      description="Preferences you choose to share with your Dots."
      title="Memories"
    >
      <MemoryList />
    </OpenDotsPage>
  );
}

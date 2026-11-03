import {
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
} from "@tabler/icons-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { buttonVariants } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { appConfig } from "@/lib/generated/application-config";
import { cn } from "@/lib/utils";

/**
 * The frame every onboarding step sits in: one DOM, laid out two ways by CSS.
 *
 * FROM `lg` UP, TWO PANES, words and real controls on the left and the picture on the right, as on
 * the rest of the app. On the left, one line with the product's name and where somebody is
 * ("Step 1 of 3", left out when there is only one step), then the step's heading and sentence, and
 * Back and Continue at the bottom right of the pane, where they sit at the same place on every step
 * however long its words are. On the right, filling the rest of the screen, the step's picture.
 *
 * THE STEP COMES FIRST, AND THE LIST IS ON DEMAND. The whole list of steps used to sit above the
 * heading, nine rows that pushed every step's words 300 to 640 px down a laptop's screen. Where
 * somebody is takes one line now, and pressing it opens the list over the page, where a step
 * already reached can be picked and the ones ahead cannot. Opening it moves nothing, so the step's
 * words and its buttons sit at the same height on every step and fit a 1280 by 700 window.
 *
 * BELOW `lg`, ONE COLUMN, for a phone: a round back chevron at the top left, the steps as dashes
 * across the top, the heading and its picture, and the buttons pinned to the bottom, full width,
 * with a fade above them where the step scrolls under.
 *
 * The frame owns where things are, never what a step says. Back, the list and the buttons sit in
 * the same place on every step, so moving through onboarding never moves the control somebody is
 * about to press. Back is drawn twice, once for each layout, and only one is ever displayed: each
 * sits where its layout's reading order puts it, so the keyboard meets it where the eye does.
 *
 * AN OPTIONAL STEP HAS A SECOND BUTTON. "Not now" goes beside the primary (under it on a phone, the
 * same size and shape, outlined), and its place is kept when it goes (`reserveSecondary`), so the
 * primary does not move mid-step. A footnote, where a step has one, sits just above the buttons.
 */
export function OnboardingFrame({
  titles,
  index,
  reached,
  onBack,
  onPick,
  primary,
  secondary,
  reserveSecondary = false,
  footnote,
  notice,
  intro,
  demo,
  demoFirst = false,
}: {
  /** Every step's name, in order. */
  titles: string[];
  /** Zero-based. */
  index: number;
  /** The furthest step reached: every step up to it can be picked from the list. */
  reached: number;
  onBack: () => void;
  onPick: (index: number) => void;
  primary: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    /** Drawn green with a check: what the button asked for has happened. */
    done?: boolean;
    /** Waiting on an answer, such as the browser's prompt: a spinner beside the label. */
    pending?: boolean;
    /** Submits this form instead of calling `onClick`. */
    form?: string;
  };
  /** A way past the step, such as Not now. */
  secondary?: { label: string; onClick: () => void };
  /** Keep the second button's place while it has none, so the primary doesn't move. */
  reserveSecondary?: boolean;
  /** A line about the step, just above the buttons. */
  footnote?: ReactNode;
  /** Said just above the buttons, such as a save that failed. */
  notice?: ReactNode;
  /** The heading, its sentence, and anything that belongs with them. */
  intro: ReactNode;
  /** The picture, or the step's own rows. */
  demo?: ReactNode;
  /** Below `lg`, the picture above the heading. */
  demoFirst?: boolean;
}) {
  const total = titles.length;
  const shape =
    "h-[52px] w-full rounded-full px-5 text-sm font-semibold lg:h-10 lg:w-auto lg:min-w-32 lg:rounded-lg";
  return (
    <div
      className="grid min-h-svh w-full min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_auto_1fr_auto] bg-background text-foreground lg:h-svh lg:grid-cols-[minmax(28rem,40rem)_minmax(0,1fr)] lg:grid-rows-[auto_auto_1fr_auto]"
      data-onboarding-frame=""
    >
      <header className="sticky top-0 z-10 col-start-1 row-start-1 bg-background lg:col-start-1 pt-[env(safe-area-inset-top)] lg:static lg:bg-transparent lg:px-10 lg:pt-10">
        {/*
         * The phone's chrome. Back is not drawn on the first step, rather than drawn disabled: there
         * is nowhere behind it, and a control that does nothing is one more thing a screen reader
         * stops on.
         */}
        <div className="relative flex h-[68px] items-center justify-center px-[76px] lg:hidden">
          {index > 0 ? (
            <button
              aria-label="Back"
              className="bg-background/80 backdrop-blur absolute left-4 grid size-11 place-items-center rounded-full text-foreground ring-1 ring-border shadow-lg outline-none transition-transform focus-visible:ring-3 focus-visible:ring-ring active:scale-95 motion-reduce:transition-none"
              data-onboarding-back="phone"
              onClick={onBack}
              type="button"
            >
              <IconChevronLeft className="size-5" stroke={2.2} />
            </button>
          ) : null}
          {total > 1 ? <StepDashes index={index} total={total} /> : null}
        </div>
        <div className="hidden lg:flex lg:items-center lg:justify-between lg:gap-4">
          <div className="text-sm flex items-center gap-2 font-semibold">
            <AgentOrb size="24px" />
            {appConfig.brand.productName}
          </div>
          {titles.length > 1 ? (
            <StepMenu
              index={index}
              onPick={onPick}
              reached={reached}
              titles={titles}
            />
          ) : null}
        </div>
      </header>

      <div
        className={cn(
          "col-start-1 min-w-0 px-4 lg:col-start-1 lg:row-start-2 lg:px-10 lg:pt-24",
          demoFirst ? "row-start-3" : "row-start-2 pt-1.5",
        )}
        data-onboarding-intro=""
      >
        {intro}
      </div>

      {/*
       * On a desktop the picture fills its column by stretching, at most a screen tall, rather than
       * being set to the screen's height: a set height spanning every row would hand its height to
       * the empty last row before the step list got its own. No margin there either, which would
       * stop it short of the bottom.
       */}
      {demo ? (
        <div
          className={cn(
            "col-start-1 flex min-w-0 flex-col px-4 lg:sticky lg:top-0 lg:col-start-2 lg:row-span-4 lg:row-start-1 lg:my-0 lg:max-h-svh lg:overflow-y-auto lg:border-l lg:border-border lg:bg-muted/40 lg:px-10 lg:py-10",
            demoFirst ? "row-start-2 mb-6" : "row-start-3 mt-8",
          )}
          data-onboarding-demo=""
        >
          <div className="mx-auto w-full max-w-xl lg:my-auto">{demo}</div>
        </div>
      ) : null}

      {/*
       * On a phone, a step taller than the screen scrolls under the buttons rather than being cut
       * at them: the fade above says there is more. On a desktop they sit at the bottom of the
       * pane, under the row that takes up the space between them and the sentence.
       */}
      <footer className="sticky bottom-0 col-start-1 row-start-5 bg-background px-4 pt-3 pb-[max(env(safe-area-inset-bottom),20px)] before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-linear-to-t before:from-background before:to-transparent lg:static lg:col-start-1 lg:row-start-4 lg:bg-transparent lg:px-10 lg:pt-8 lg:pb-10 lg:before:hidden">
        <div className="mx-auto flex w-full max-w-md flex-col gap-3 lg:mx-0 lg:max-w-none">
          {notice}
          {footnote ? (
            <p
              className="text-xs line-clamp-4 px-2 text-center text-muted-foreground lg:px-0 lg:text-left"
              data-onboarding-footnote=""
            >
              {footnote}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-end lg:gap-3">
            {index > 0 ? (
              <button
                className={cn(
                  buttonVariants({ variant: "ghost", size: "lg" }),
                  "text-sm hidden font-semibold lg:order-first lg:inline-flex",
                )}
                data-onboarding-back="desktop"
                onClick={onBack}
                type="button"
              >
                <IconChevronLeft className="size-4" />
                Back
              </button>
            ) : null}
            <button
              aria-busy={primary.pending ? true : undefined}
              className={cn(
                buttonVariants({ size: "lg" }),
                shape,
                // Last on a desktop, so the way forward is the rightmost button; first on a phone.
                "motion-reduce:transition-none lg:order-last",
                primary.done &&
                  "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10",
              )}
              data-done={primary.done ? "" : undefined}
              data-onboarding-primary=""
              data-pending={primary.pending ? "" : undefined}
              disabled={primary.disabled}
              form={primary.form}
              onClick={primary.form ? undefined : primary.onClick}
              type={primary.form ? "submit" : "button"}
            >
              {primary.done ? <IconCheck className="size-4.5" /> : null}
              {primary.pending ? (
                <span
                  aria-hidden
                  className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
                />
              ) : null}
              {primary.label}
            </button>
            {secondary ? (
              <button
                className={cn(
                  buttonVariants({ variant: "outline", size: "lg" }),
                  shape,
                  "lg:min-w-0 lg:border-transparent lg:bg-transparent lg:shadow-none lg:dark:border-transparent lg:dark:bg-transparent",
                )}
                data-onboarding-secondary=""
                onClick={secondary.onClick}
                type="button"
              >
                {secondary.label}
              </button>
            ) : reserveSecondary ? (
              <div
                aria-hidden
                className="h-[52px] lg:hidden"
                data-onboarding-secondary-slot=""
              />
            ) : null}
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * Where somebody is, on a desktop: "Step 1 of 3", which opens the list of steps over the page.
 *
 * In the list each step has a mark, done ones ticked and the one on screen filled. A step already
 * reached is a button back to it, and picking one closes the list; one ahead is only its name.
 *
 * SAID, NOT ONLY DRAWN. The marks are pictures and hidden, so what they show is said in words a
 * screen reader reads with the name: "Welcome to OpenBot, done", and "Talk to us, not yet
 * available" for a step ahead. The step on screen is `aria-current="step"`.
 */
function StepMenu({
  titles,
  index,
  reached,
  onPick,
}: {
  titles: string[];
  index: number;
  reached: number;
  onPick: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "text-xs -me-2 gap-1 font-medium text-muted-foreground",
        )}
        data-onboarding-steps=""
      >
        Step {index + 1} of {titles.length}
        <IconChevronDown aria-hidden className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-88 gap-1 p-1.5">
        <PopoverTitle className="text-xs px-2 pt-1 text-muted-foreground">
          Steps
        </PopoverTitle>
        <nav aria-label="Onboarding steps">
          <ol className="flex flex-col">
            {titles.map((title, at) => {
              const current = at === index;
              const done = at < index;
              const pickable = !current && at <= reached;
              const body = (
                <>
                  <span
                    aria-hidden
                    className={cn(
                      "text-xs grid size-6 shrink-0 place-items-center rounded-full font-semibold tabular-nums",
                      current
                        ? "bg-primary text-primary-foreground"
                        : done
                          ? "bg-foreground/8 text-foreground"
                          : "text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]",
                    )}
                  >
                    {done ? (
                      <IconCheck className="size-3.5" stroke={2.6} />
                    ) : (
                      at + 1
                    )}
                  </span>
                  <span className="min-w-0 truncate">{title}</span>
                  {done ? (
                    <span className="sr-only">, done</span>
                  ) : !current && !pickable ? (
                    <span className="sr-only">, not yet available</span>
                  ) : null}
                </>
              );
              const row =
                "text-sm flex min-h-8 w-full items-center gap-3 rounded-lg px-2 py-1 text-left";
              return (
                <li key={title}>
                  {pickable ? (
                    <button
                      className={cn(
                        row,
                        "text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring",
                      )}
                      data-onboarding-pick={at}
                      onClick={() => {
                        setOpen(false);
                        onPick(at);
                      }}
                      type="button"
                    >
                      {body}
                    </button>
                  ) : (
                    <div
                      aria-current={current ? "step" : undefined}
                      className={cn(
                        row,
                        current
                          ? "bg-muted font-medium text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Where somebody is, as short dashes with the current one filled, on a phone.
 *
 * A progress bar to assistive technology, read as "Step 3 of 7": the dashes are a picture of that
 * sentence, so they are hidden and the sentence is what is announced.
 */
export function StepDashes({ index, total }: { index: number; total: number }) {
  return (
    <div
      aria-label="Onboarding progress"
      aria-valuemax={total}
      aria-valuemin={1}
      aria-valuenow={index + 1}
      aria-valuetext={`Step ${index + 1} of ${total}`}
      className="flex w-full min-w-0 max-w-[228px] items-center gap-[6px]"
      role="progressbar"
    >
      {Array.from({ length: total }, (_, at) => (
        <span
          aria-hidden
          className={cn(
            "h-1 min-w-0 flex-1 rounded-full transition-colors duration-300 motion-reduce:transition-none",
            at === index ? "bg-foreground" : "bg-muted-foreground/35",
          )}
          data-current={at === index ? "" : undefined}
          // biome-ignore lint/suspicious/noArrayIndexKey: the dashes are positions, fixed in order.
          key={at}
        />
      ))}
    </div>
  );
}

/**
 * The name of the step being drawn, which is also its name in the list of steps. The wizard
 * provides it, so a step's heading and its place in the list can't say two different things.
 */
export const StepTitle = createContext<string | undefined>(undefined);

/**
 * A step's heading and sentence, the way every step draws them: centred on a phone, flush left in
 * the desktop's right pane. `children` is the sentence; `after` is a control that belongs with it.
 * The heading is the step's own title from the list unless `title` says otherwise.
 */
export function StepIntro({
  title: given,
  children,
  after,
}: {
  title?: ReactNode;
  children?: ReactNode;
  after?: ReactNode;
}) {
  const named = useContext(StepTitle);
  const title = given ?? named;
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center text-center lg:mx-0 lg:items-start lg:text-left">
      <h1 className="text-3xl font-semibold tracking-tight text-pretty [overflow-wrap:anywhere] focus:outline-none">
        {title}
      </h1>
      {children ? (
        <div className="text-base mt-3 flex max-w-md flex-col gap-2 text-pretty text-muted-foreground">
          {children}
        </div>
      ) : null}
      {after ? <div className="mt-6 w-full">{after}</div> : null}
    </div>
  );
}

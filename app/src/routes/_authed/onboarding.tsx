import { useMutation, useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  redirect,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import * as React from "react";
import { SELF_HOST_URL } from "@/components/layout/self-host-banner";
import { AskFirstSwitch } from "@/components/onboarding/ask-first-switch";
import { IntroReel } from "@/components/onboarding/demos/intro-reel";
import { SelfHostDemo } from "@/components/onboarding/demos/self-host-demo";
import { FINISH_MS, useNameStep } from "@/components/onboarding/name-step";
import { StepIntro } from "@/components/onboarding/onboarding-frame";
import {
  type OnboardingStep,
  OnboardingWizard,
} from "@/components/onboarding/onboarding-wizard";
import { Button } from "@/components/ui/button";
import { currentUserQueryOptions, needsOnboarding } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { appConfig } from "@/lib/generated/application-config";
import {
  advanceOnboardingMutationOptions,
  completeOnboardingMutationOptions,
} from "@/lib/onboarding/mutations";
import { setupChecklistQueryOptions } from "@/lib/setup/queries";
import { queryClient } from "@/query-client";

const PRODUCT = appConfig.brand.productName;

/**
 * Every step, by id, with the number the server stores for it.
 *
 * `POST /api/me/onboarding` keeps a step as an integer, so each id has a number of its own. A
 * number per id, never a position in the list: Talk to us joins the list only for somebody trying
 * OpenBot alone, and the name step leaves it for somebody whose name is known, so a position would
 * mean different steps to different people. 0 is the server's "not started".
 */
const STEP_NUMBER = {
  welcome: 1,
  selfhost: 2,
  name: 3,
} as const;
type StepId = keyof typeof STEP_NUMBER;

const isStepId = (value: unknown): value is StepId =>
  typeof value === "string" && Object.hasOwn(STEP_NUMBER, value);

/** The step a stored number names, or null for "not started" and for a number no step has. */
function stepForNumber(step: number | undefined): StepId | null {
  const found = Object.entries(STEP_NUMBER).find(([, at]) => at === step);
  return found ? (found[0] as StepId) : null;
}

/**
 * The step somebody was last on. Kept in the history entry Continue pushed (`onboardingFrom`), so
 * Back after a reload still pops the entry instead of adding a second one for the same step.
 */
type OnboardingEntry = { onboardingFrom?: unknown };

export const Route = createFileRoute("/_authed/onboarding")({
  /*
   * WHERE SOMEBODY IS LIVES IN THE ADDRESS. `?step=<id>` is the step on screen, so a reload stays
   * on it, and browser Back and Forward walk the steps. Anything else is ignored.
   */
  validateSearch: (search: Record<string, unknown>): { step?: StepId } => ({
    // Named even when absent: the router lays this over the raw search, so a key left out would
    // keep whatever was typed into the address.
    step: isStepId(search.step) ? search.step : undefined,
  }),
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    // Somebody who has finished, or whose deployment tracks no onboarding, has no business here.
    if (!user || !needsOnboarding(user)) {
      throw redirect({ to: "/" });
    }
  },
  component: RouteComponent,
});

/*
 * THREE CLICKS AT MOST INTO THE APP. Welcome, then Talk to us for somebody trying OpenBot alone,
 * then the name. Everything else waits for the app: the setup checklist lives in Settings → Setup,
 * apps are connected from Connections when a Bot needs one, and notifications are offered once the
 * first task has started (`NotifyPrompt`), when what they are for is plain.
 */

/**
 * The welcome step: one animation of what OpenBot does, and beside it the one choice worth making
 * before the first task, whether a Bot asks before it changes anything.
 *
 * The animation is a picture and the switch is real, so they never share a pane: the switch sits
 * with the words, and the picture stays a picture.
 */
function welcomeStep(computer: boolean): OnboardingStep {
  return {
    id: "welcome",
    title: `Welcome to ${PRODUCT}`,
    intro: () => (
      <StepIntro
        after={
          <section
            aria-labelledby="onboarding-permissions"
            className="flex flex-col gap-3 text-left"
          >
            <div className="flex flex-col gap-1">
              <h2
                className="text-lg font-semibold text-pretty"
                id="onboarding-permissions"
              >
                Set up your permissions
              </h2>
              <p className="text-pretty text-muted-foreground">
                Turn this on to review changes before a Bot makes them.
              </p>
            </div>
            <AskFirstSwitch />
            <p className="text-sm text-pretty text-muted-foreground">
              Paying, deleting, sending, sharing, posting and changing account
              security always wait for you. You can change this later in
              Settings.
            </p>
          </section>
        }
      >
        <p>Hand work to Bots in plain words. They tell you when it's done.</p>
      </StepIntro>
    ),
    demo: () => <IntroReel computer={computer} />,
  };
}

/*
 * TALK TO US IS FOR SOMEBODY TRYING OPENBOT ON THEIR OWN MACHINE, and only they see it (see
 * `localEvaluation` in RouteComponent). None of it is said to an organization's own people, who
 * already have OpenBot.
 */
const selfhost: OnboardingStep = {
  id: "selfhost",
  title: "Talk to us",
  intro: () => (
    <StepIntro>
      <p>
        Thinking about {PRODUCT} for your team? Book a call and we'll walk you
        through running it for your organization.
      </p>
    </StepIntro>
  ),
  demo: () => <SelfHostDemo />,
  // A new tab, so booking doesn't cost the place in onboarding, and then on to the next step.
  primaryLabel: "Book a call",
  onPrimary: (next) => {
    window.open(SELF_HOST_URL, "_blank", "noopener,noreferrer");
    next();
  },
  secondary: { label: "Not now" },
};

function RouteComponent() {
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const search = Route.useSearch();
  const complete = useMutation(completeOnboardingMutationOptions(queryClient));
  const advance = useMutation(advanceOnboardingMutationOptions(queryClient));
  const me = useQuery(currentUserQueryOptions());

  /*
   * Talk to us is for somebody evaluating OpenBot locally, never for an organization's people: the
   * server says single-user mode, which an organization's deployment, always behind sign-in, cannot
   * be in. Until the answer arrives it is left out, and Welcome's button waits for it, so a slow or
   * failed request never shows an organization's employees a page about booking a call, and an
   * evaluator never walks past theirs.
   *
   * NOT GATED ON `selfHostBanner` AS WELL. That flag is off for any deployment with a paid
   * Intelligence entitlement, and the stack `copilotkit local` installs runs on an enterprise
   * evaluation licence, so every CLI evaluator, the person this step is for, would never see it.
   */
  const {
    data: capabilities,
    error: capabilitiesError,
    refetch: retryCapabilities,
    isFetching: loadingCapabilities,
    isPending: askingCapabilities,
  } = useQuery(deploymentCapabilitiesQueryOptions());

  /*
   * A NAME ALREADY KNOWN IS NOT ASKED FOR AGAIN. A sign-in that brought a real name leaves the name
   * step out, and the last step left gets the person in instead.
   *
   * DECIDED ONCE, ON ARRIVAL. Saving the name on the name step makes it known, and deciding again
   * then would drop the step from under its own finish, back to Welcome. `beforeLoad` has the user
   * in the cache before the first render, so the first answer is the real one.
   */
  const [nameKnown] = React.useState(
    () =>
      me.data?.needsName !== true &&
      Boolean(me.data?.name) &&
      me.data?.name !== me.data?.email,
  );
  const ids: StepId[] = [
    "welcome",
    ...(capabilities?.localEvaluation ? (["selfhost"] as const) : []),
    ...(nameKnown ? [] : (["name"] as const)),
  ];

  /*
   * The step on screen: the address's, else the one the server saved, else the first. A step not in
   * this person's list (Talk to us for an organization's person, the name step once it is known)
   * reads as the last one they have, once the answer that decides it is in. Arriving without a step
   * writes it into the address in place, so the entry the person lands on already names its step.
   */
  const reachable = (step: StepId | null | undefined): StepId | undefined => {
    if (!step) return undefined;
    if (step === "selfhost" && !capabilities) return step;
    return ids.includes(step) ? step : ids[ids.length - 1];
  };
  const saved = reachable(stepForNumber(me.data?.onboarding?.step));
  const asked = reachable(isStepId(search.step) ? search.step : undefined);
  const current: StepId = asked ?? saved ?? "welcome";
  React.useEffect(() => {
    if (asked !== undefined && asked === search.step) return;
    navigate({ to: "/onboarding", search: { step: current }, replace: true });
  }, [navigate, current, asked, search.step]);

  // Saved wherever the person goes, by Continue, Back or the browser.
  const savedStep = me.data?.onboarding?.step;
  const { mutate: save } = advance;
  React.useEffect(() => {
    if (savedStep === undefined || savedStep === STEP_NUMBER[current]) return;
    // Talk to us waits for the answer that says whether this person has one.
    if (current === "selfhost" && !capabilities) return;
    /*
     * A save that fails is tried again on the next move, since the saved step still differs. It is
     * said in the console rather than on the step: the person is where they meant to be, and only a
     * reload would show the place was not kept.
     */
    save(STEP_NUMBER[current], {
      onError: (error) =>
        console.warn("Your place in onboarding was not saved.", error),
    });
  }, [current, savedStep, save, capabilities]);

  /*
   * CONTINUE PUSHES, AND BACK RETURNS THROUGH HISTORY WHEN IT CAN. Continue adds an entry carrying
   * the step it was pressed on, so browser Back walks back a step. The frame's Back pops that entry
   * when it was pushed from the step behind, and otherwise (arriving by a link, say) replaces this
   * entry with the step behind, so history never holds the same step twice in a row.
   */
  const cameFrom = (location.state as OnboardingEntry).onboardingFrom;
  const move = (to: string, way: "forward" | "back") => {
    if (!isStepId(to)) return;
    if (way === "back" && cameFrom === to) {
      router.history.back();
      return;
    }
    const state: Record<string, unknown> =
      way === "forward" ? { onboardingFrom: current } : {};
    navigate({
      to: "/onboarding",
      search: { step: to },
      replace: way === "back",
      state,
    });
  };

  /*
   * THE WAY OUT IS THE LAST STEP'S BUTTON. On the name step, Get started saves the name first. Then
   * completion is saved, the orb or the button plays its finish, the page fades, and the app opens.
   * A completion that fails is said on the step, and the button can be pressed again.
   */
  const reduced = useReducedMotion() === true;
  const [finished, setFinished] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  const finish = async () => {
    await complete.mutateAsync(undefined);
    setFinished(true);
    await new Promise((resolve) =>
      setTimeout(resolve, reduced ? 150 : FINISH_MS),
    );
    setLeaving(true);
  };
  React.useEffect(() => {
    if (!leaving) return;
    // Navigation must also complete in a background tab, where animation frames may pause.
    const timer = setTimeout(() => navigate({ to: "/" }), reduced ? 0 : 300);
    return () => clearTimeout(timer);
  }, [leaving, navigate, reduced]);

  const name = useNameStep({ finish, finished });
  /*
   * The checklist says whether there is a Bot computer, and the intro shows one only where there
   * is. Until it answers, the usual case: a computer that is there.
   */
  const { data: checklist } = useQuery(setupChecklistQueryOptions());
  const computerMissing =
    checklist?.rows.find((row) => row.id === "computer")?.status ===
    "needs_setup";

  const capabilitiesFailed =
    capabilitiesError && !capabilities ? (
      <div className="flex flex-col items-center gap-1 lg:items-start">
        <p
          className="text-sm text-center text-destructive lg:text-left"
          role="alert"
        >
          Couldn't load your setup. Try again to continue.
        </p>
        <Button
          disabled={loadingCapabilities}
          onClick={() => retryCapabilities()}
          size="sm"
          variant="ghost"
        >
          Try again
        </Button>
      </div>
    ) : undefined;
  const finishFailed = complete.error ? (
    <p
      className="text-sm text-center text-destructive lg:text-left"
      role="alert"
    >
      Couldn't finish setting up. Try again.
    </p>
  ) : undefined;

  const byId: Record<StepId, OnboardingStep> = {
    welcome: {
      ...welcomeStep(!computerMissing),
      primaryDisabled: !capabilities,
      notice: capabilitiesFailed,
    },
    selfhost,
    name,
  };
  /*
   * Without the name step, the last step's buttons finish onboarding where they would have moved
   * on: Get started on Welcome, and Book a call or Not now on Talk to us.
   */
  const lastId = ids[ids.length - 1];
  const steps: OnboardingStep[] = ids.map((id) => {
    const step = byId[id];
    if (id !== lastId || id === "name") return step;
    const out = () => void finish().catch(() => undefined);
    return {
      ...step,
      primaryLabel: finished ? "All set" : (step.primaryLabel ?? "Get started"),
      primaryDone: finished,
      primaryPending: complete.isPending,
      onPrimary: () => {
        step.onPrimary?.(() => undefined);
        out();
      },
      secondary: step.secondary
        ? { label: step.secondary.label, onClick: out }
        : undefined,
      notice: step.notice ?? finishFailed,
    };
  });

  // A Talk to us step in the address waits for the answer that puts it in the list, rather than
  // drawing Welcome for a moment and then jumping.
  const waiting = askingCapabilities && current === "selfhost";

  return (
    // Outside `_app` on purpose: no sidebar and no chrome until onboarding is done.
    // The fade runs only after the completion is saved, so a failed save never fades a page the
    // person still needs, and navigation waits for the fade, so the next screen never pops in over
    // a half-faded onboarding.
    <motion.div
      animate={{ opacity: leaving ? 0 : 1 }}
      className={`min-h-svh w-full ${leaving ? "pointer-events-none" : ""}`}
      initial={false}
      transition={{ duration: reduced ? 0 : 0.3, ease: "easeOut" }}
    >
      {waiting ? null : (
        <OnboardingWizard
          onMove={(to, way) => move(to, way)}
          stepId={current}
          steps={steps}
        />
      )}
    </motion.div>
  );
}

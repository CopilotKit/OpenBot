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
import { FINISH_MS } from "@/components/agents/orb/bot-orb";
import { SELF_HOST_URL } from "@/components/layout/self-host-banner";
import {
  type ConsentApp,
  ConnectAppsStep,
} from "@/components/onboarding/connect-apps-step";
import { ApprovalDemo } from "@/components/onboarding/demos/approval-demo";
import { ComputerDemo } from "@/components/onboarding/demos/computer-demo";
import { SelfHostDemo } from "@/components/onboarding/demos/self-host-demo";
import { TeamDemo } from "@/components/onboarding/demos/team-demo";
import { WelcomeDemo } from "@/components/onboarding/demos/welcome-demo";
import { useNotifyStep } from "@/components/onboarding/notify-step";
import { StepIntro } from "@/components/onboarding/onboarding-frame";
import {
  type OnboardingStep,
  OnboardingWizard,
} from "@/components/onboarding/onboarding-wizard";
import { SetupChecklist } from "@/components/onboarding/setup-checklist";
import {
  OnboardingNameOrb,
  OnboardingNameStep,
} from "@/components/settings/profile";
import { Button, buttonVariants } from "@/components/ui/button";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions, needsOnboarding } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { appConfig } from "@/lib/generated/application-config";
import {
  advanceOnboardingMutationOptions,
  completeOnboardingMutationOptions,
} from "@/lib/onboarding/mutations";
import { setupChecklistQueryOptions } from "@/lib/setup/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

const PRODUCT = appConfig.brand.productName;

/**
 * Every step, by id, with the number the server stores for it.
 *
 * `POST /api/me/onboarding` keeps a step as an integer, so each id has a number of its own. A
 * number per id, never a position in the list: the self-hosting step joins the list only for
 * somebody trying OpenBot alone, and a position would mean a different step to them than to
 * everybody else. 0 is the server's "not started".
 */
const STEP_NUMBER = {
  welcome: 1,
  computer: 2,
  team: 3,
  approval: 4,
  selfhost: 5,
  apps: 6,
  notify: 7,
  setup: 8,
  name: 9,
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
 * A page of this app, and nothing else: a path, never another origin, a scheme, a query or a walk
 * upward. What a checklist link opens once onboarding is done, carried in the address as `?open=`
 * so a reload on the name step keeps it.
 */
/** Pages a step other than the checklist can carry through the name step, by what they're called. */
const STEP_PAGES: Record<string, string> = { "/admin/plugins": "Plugins" };

const isAppPath = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\/(?!\/)[\w/-]*$/.test(value) &&
  !value.includes("..");

/**
 * The step Continue was pressed on, kept in the history entry it pushed (`onboardingFrom`). Kept in
 * the entry rather than in memory, so it survives a reload: Back after a reload still pops the
 * entry instead of adding a second one for the same step.
 */
type OnboardingEntry = { onboardingFrom?: unknown };

/**
 * A consent in flight: the step it left from, the history entry it left, and the app it was for,
 * in this tab's session storage so it survives the trip to the vendor and back.
 */
const CONSENT_KEY = "openbot-onboarding-consent";
type ConsentDeparture = {
  step: StepId;
  entry: string | null;
  from?: StepId;
  app?: ConsentApp;
};

/** The key TanStack Router gives the current history entry, or null. */
function currentEntryKey(): string | null {
  const state = window.history.state as { __TSR_key?: unknown } | null;
  return typeof state?.__TSR_key === "string" ? state.__TSR_key : null;
}

/** Leaves for a vendor's consent from a step, noting where from and for which app. */
function leaveForConsent(step: StepId, url: string, app: ConsentApp) {
  try {
    sessionStorage.setItem(
      CONSENT_KEY,
      JSON.stringify({
        step,
        entry: currentEntryKey(),
        from: (window.history.state as OnboardingEntry | null)?.onboardingFrom,
        app,
      }),
    );
  } catch {
    // Storage refused: the return still lands on the step, Back just isn't rewritten.
  }
  window.location.assign(url);
}

/** The consent this tab left for, if there is one. Read only; dropped once it has been used. */
function readConsentDeparture(): ConsentDeparture | null {
  try {
    const raw = sessionStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      step?: unknown;
      entry?: unknown;
      from?: unknown;
      app?: { serverId?: unknown; brokered?: unknown };
    };
    if (!isStepId(parsed.step)) return null;
    return {
      step: parsed.step,
      entry: typeof parsed.entry === "string" ? parsed.entry : null,
      from: isStepId(parsed.from) ? parsed.from : undefined,
      app:
        typeof parsed.app?.serverId === "string"
          ? {
              serverId: parsed.app.serverId,
              brokered: parsed.app.brokered === true,
            }
          : undefined,
    };
  } catch {
    return null;
  }
}

function dropConsentDeparture() {
  try {
    sessionStorage.removeItem(CONSENT_KEY);
  } catch {
    // Nothing to drop.
  }
}

export const Route = createFileRoute("/_authed/onboarding")({
  /*
   * WHERE SOMEBODY IS LIVES IN THE ADDRESS. `?step=<id>` is the step on screen, so a reload stays
   * on it, browser Back and Forward walk the steps, and a consent started on a step comes back to
   * it (`?step=apps`; see `connectedAccountsUrlFor` on the server). `?connected=failed` says that
   * consent did not go through, and is dropped once read. `?open=` is the page a checklist link
   * asked for, opened once the name step finishes. Anything else is ignored.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { step?: StepId; connected?: "failed"; open?: string } => ({
    // Named even when absent: the router lays this over the raw search, so a key left out would
    // keep whatever was typed into the address.
    step: isStepId(search.step) ? search.step : undefined,
    connected: search.connected === "failed" ? "failed" : undefined,
    open: isAppPath(search.open) ? search.open : undefined,
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

const welcome: OnboardingStep = {
  id: "welcome",
  title: "Welcome",
  intro: () => (
    <StepIntro title={`Welcome to ${PRODUCT}`}>
      <p>
        Ask for what you need in plain words. A Bot takes it from there and
        tells you when it's done.
      </p>
    </StepIntro>
  ),
  demo: () => <WelcomeDemo />,
};

const computer: OnboardingStep = {
  id: "computer",
  title: "A browser and files of its own",
  intro: () => (
    <StepIntro title="Each Bot has its own browser and files">
      <p>
        It opens a browser, reads pages and works with files on a computer
        OpenBot runs for you, so yours stays yours.
      </p>
    </StepIntro>
  ),
  demo: () => <ComputerDemo />,
};

const team: OnboardingStep = {
  id: "team",
  title: "Your team of Bots",
  intro: () => (
    <StepIntro title="Pick a Bot or make your own">
      <p>
        Each Bot has its own job. Hand work to the one that fits, or make a new
        one whenever you need it.
      </p>
    </StepIntro>
  ),
  demo: () => <TeamDemo />,
};

/*
 * Said as OpenBot behaves out of the box: "Ask before making changes" starts off, so a Bot asks only
 * where a rule says to, and paying or changing account security is always handed to the person
 * (`server/src/approvals/policy.ts`).
 */
const approval: OnboardingStep = {
  id: "approval",
  title: "You decide what it asks",
  intro: () => (
    <StepIntro title="You decide what it asks about">
      <p>
        Paying for things and changing account security are always left to you.
        For everything else, turn on Ask before making changes in Settings, or
        give a Bot its own rules. When a Bot asks, allow it once or always allow
        it there.
      </p>
    </StepIntro>
  ),
  demo: () => <ApprovalDemo />,
};

/*
 * THE SELF-HOSTING STEP IS FOR SOMEBODY TRYING OPENBOT ON THEIR OWN MACHINE, and only they see it
 * (see `localEvaluation` in RouteComponent). It answers what that person is deciding: where their
 * data is, whether their own agents fit, and what taking it to their organization involves. None of
 * it is said to an organization's own people, who are past all three.
 */
const selfhost: OnboardingStep = {
  id: "selfhost",
  title: "Running it yourself",
  intro: () => (
    <StepIntro
      after={
        /*
         * The one real control on the intro, so it sits outside the picture: a frame means
         * picture. A new tab, because following it must not cost this person their place.
         */
        <a
          className={cn(
            buttonVariants({ variant: "outline" }),
            "h-auto min-h-(--target) max-w-full whitespace-normal text-center",
          )}
          href={SELF_HOST_URL}
          rel="noopener noreferrer"
          target="_blank"
        >
          Talk to an engineer
        </a>
      }
      title="It runs on your machine"
    >
      {/*
       * Said as it is: files and Bot settings stay here, but every request goes to the model
       * provider this install was set up with, and Intelligence keeps the conversations.
       */}
      <p>
        Files and Bot settings stay on this computer. Requests go to your model
        provider, and CopilotKit Intelligence keeps your conversations and
        memory.
      </p>
      <p>
        Any AG-UI agent can join as a Bot. For your organization, run one
        container image or a Helm chart.
      </p>
    </StepIntro>
  ),
  demo: () => <SelfHostDemo />,
};

function RouteComponent() {
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const search = Route.useSearch();
  const complete = useMutation(completeOnboardingMutationOptions(queryClient));
  const advance = useMutation(advanceOnboardingMutationOptions(queryClient));
  const me = useQuery(currentUserQueryOptions());

  // A failed consent is told once, on the step it came back to: not after a reload, and not after
  // the person has moved on and come back.
  const [failedOn, setFailedOn] = React.useState(() =>
    search.connected === "failed" && isStepId(search.step) ? search.step : null,
  );

  /*
   * BACK FROM A CONSENT. Leaving for a vendor's consent leaves its page in this tab's history, so
   * browser Back right after the return used to land on the vendor rather than on the step before.
   * The browser keeps that entry whatever this page does, so the return rewrites the entries after
   * it: the one it arrived on becomes the step before, and the step itself is pushed on top, from
   * it. Back then walks to the step before, as it would had the person pressed Continue to get
   * here, and the vendor's page is one further back. Not on a return to the very entry that left,
   * which is the person pressing Back on the vendor's page rather than finishing there.
   */
  const [departure] = React.useState(() => readConsentDeparture());
  const [returned, setReturned] = React.useState<StepId | null>(() => {
    if (!departure || departure.step !== search.step) return null;
    return departure.entry !== null && departure.entry === currentEntryKey()
      ? null
      : departure.step;
  });
  // The app that consent was for, which the apps step asks the vendor about, once.
  const [returnedApp] = React.useState(() =>
    departure && departure.step === search.step
      ? (departure.app ?? null)
      : null,
  );

  /*
   * The step on screen: the address's, else the one the server saved, else the first. Arriving
   * without one (from the gate's redirect, say) writes it into the address in place, so the entry
   * the person lands on already names its step. `connected` is dropped the same way, and only it.
   */
  const saved = stepForNumber(me.data?.onboarding?.step);
  const asked = isStepId(search.step) ? search.step : undefined;
  const current: StepId = asked ?? saved ?? "welcome";
  React.useEffect(() => {
    if (returned !== null) return;
    if (asked !== undefined && search.connected === undefined) return;
    navigate({
      to: "/onboarding",
      search: { step: current, open: search.open },
      replace: true,
      // A consent rewrite may have just pushed this entry before the route caught up.
      // Keep its origin when removing the one-shot outcome from the address.
      state: router.history.location.state,
    });
  }, [
    navigate,
    current,
    asked,
    search.connected,
    search.open,
    returned,
    router,
  ]);

  // Saved wherever the person goes, by Continue, Back, the browser or a consent's return.
  const savedStep = me.data?.onboarding?.step;
  const { mutate: save } = advance;
  React.useEffect(() => {
    if (savedStep === undefined || savedStep === STEP_NUMBER[current]) return;
    save(STEP_NUMBER[current]);
  }, [current, savedStep, save]);

  /*
   * CONTINUE PUSHES, AND BACK RETURNS THROUGH HISTORY WHEN IT CAN. Continue adds an entry carrying
   * the step it was pressed on, so browser Back walks back a step. The frame's Back pops that entry
   * when it was pushed from the step behind, and otherwise (arriving by a link, say) replaces this
   * entry with the step behind, so history never holds the same step twice in a row. A page a
   * checklist link asked for rides along to the name step, and only there.
   */
  const cameFrom = (location.state as OnboardingEntry).onboardingFrom;
  const move = (
    to: string,
    way: "forward" | "back",
    open: string | undefined = undefined,
  ) => {
    if (!isStepId(to)) return;
    setFailedOn(null);
    // Skip intro pushes Apps directly. Back follows that actual path, including after reload.
    if (
      way === "back" &&
      (cameFrom === to ||
        (current === "apps" &&
          isStepId(cameFrom) &&
          STEP_NUMBER[cameFrom] < STEP_NUMBER.apps))
    ) {
      router.history.back();
      return;
    }
    const state: Record<string, unknown> =
      way === "forward" ? { onboardingFrom: current } : {};
    navigate({
      to: "/onboarding",
      search: { step: to, open: to === "name" ? open : undefined },
      replace: way === "back",
      state,
    });
  };

  /*
   * THE WAY OUT IS THE NAME STEP'S GET STARTED. It saves the name, then completion is saved, then
   * the orb plays its finish, the page fades, and the app opens: home, or the page a checklist link
   * asked for. The promise Get started waits on lasts until the fade, so its button says Saving…
   * and stays pressed the whole way out. A completion that fails is said by the form, under it.
   */
  const reduced = useReducedMotion() === true;
  const [finished, setFinished] = React.useState(false);
  const [leaving, setLeaving] = React.useState<string | null>(null);
  const finish = async () => {
    await complete.mutateAsync(undefined);
    setFinished(true);
    await new Promise((resolve) =>
      setTimeout(resolve, reduced ? 150 : FINISH_MS),
    );
    setLeaving(search.open ?? "/");
  };
  React.useEffect(() => {
    if (leaving === null) return;
    // Navigation must also complete in a background tab, where animation frames may pause.
    const timer = setTimeout(
      () => navigate({ to: leaving as "/" }),
      reduced ? 0 : 300,
    );
    return () => clearTimeout(timer);
  }, [leaving, navigate, reduced]);

  /*
   * The self-hosting step, after the intro, is for somebody evaluating OpenBot locally, never for
   * an organization's people: the server says single-user mode, which an organization's
   * deployment, always behind sign-in, cannot be in. Until the answer arrives it is left out, and
   * the intro's Continue waits for it, so a slow or failed request never shows an organization's
   * employees a page about deploying OpenBot themselves, and an evaluator never walks past theirs.
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
  const { data: agents } = useQuery(agentListQueryOptions());
  const notify = useNotifyStep(defaultAgentProfile(agents)?.name ?? PRODUCT);
  // The checklist's answer names the page a carried link opens, so the name step can say which.
  const { data: checklist } = useQuery({
    ...setupChecklistQueryOptions(),
    enabled: search.open !== undefined,
  });
  const openLabel =
    checklist?.rows
      .map((row) =>
        row.fix?.kind === "page"
          ? row.fix
          : row.fix?.kind === "env"
            ? row.fix.page
            : undefined,
      )
      .find((page) => page?.path === search.open)?.label ??
    (search.open ? STEP_PAGES[search.open] : undefined);

  const capabilitiesFailed =
    capabilitiesError && !capabilities ? (
      <div className="flex flex-col items-center gap-1 lg:items-start">
        <p
          className="type-sub text-center text-destructive lg:text-left"
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
  const intro: OnboardingStep[] = [
    welcome,
    computer,
    team,
    approval,
    ...(capabilities?.localEvaluation ? [selfhost] : []),
  ].map((step) => ({
    ...step,
    primaryDisabled: !capabilities,
    notice: capabilitiesFailed,
    secondary: { label: "Skip intro", onClick: () => move("apps", "forward") },
  }));
  const steps: OnboardingStep[] = [
    ...intro,
    /*
     * Two optional steps, before the checklist. Continue and Not now both move on, and Not now
     * writes nothing; the checklist after them says what is left to set up.
     */
    {
      id: "apps",
      title: "Connect apps",
      intro: () => (
        <StepIntro title="Connect your apps">
          <p>
            Connect the accounts your Bots use as you. You can connect more
            later in Connections.
          </p>
        </StepIntro>
      ),
      demo: () => (
        <ConnectAppsStep
          failed={failedOn === "apps"}
          leaveFor={(url, app) => leaveForConsent("apps", url, app)}
          openPage={(target) => move("name", "forward", target.path)}
          returned={returnedApp}
        />
      ),
      secondary: { label: "Not now" },
      optional: true,
    },
    notify,
    {
      id: "setup",
      title: "Check your setup",
      intro: () => (
        <StepIntro title="Check your setup">
          <p>See what's ready and what still needs setting up.</p>
        </StepIntro>
      ),
      demo: () => (
        <SetupChecklist
          // Onboarding cannot stay open behind another page, so a link goes through the name step.
          openPage={(target) => move("name", "forward", target.path)}
        />
      ),
    },
    {
      id: "name",
      title: "Your name",
      intro: () => <OnboardingNameStep onSaved={finish} />,
      demo: () => <OnboardingNameOrb finished={finished} size={128} />,
      demoFirst: true,
      ownAction: true,
      notice: openLabel ? (
        <p className="type-sub text-center text-muted-foreground lg:text-left">
          {openLabel} opens once you get started.
        </p>
      ) : undefined,
    },
  ];

  // A self-hosting step in the address waits for the answer that puts it in the list, rather
  // than drawing step 1 for a moment and then jumping.
  const waiting = askingCapabilities && current === "selfhost";

  // The rewrite described at `returned`, once the list of steps is known. The order as one string,
  // so the effect runs when the list changes rather than on every render that rebuilds it.
  const order = steps.map((step) => step.id).join(" ");
  React.useEffect(() => {
    if (returned === null || askingCapabilities) return;
    dropConsentDeparture();
    setReturned(null);
    const ids = order.split(" ");
    const at = ids.indexOf(returned);
    const before = departure?.from ?? ids[at - 1];
    if (at === -1 || !isStepId(before)) return;
    /*
     * Through the history itself, flushed between the two: the router queues history writes and
     * folds a replace followed by a push into one push, which left the arrival entry as it was.
     */
    const href = (step: StepId) =>
      router.buildLocation({ to: "/onboarding", search: { step } }).href;
    router.history.replace(href(before), {});
    router.history.flush();
    const state: Record<string, unknown> = { onboardingFrom: before };
    router.history.push(href(returned), state);
  }, [returned, askingCapabilities, order, router, departure]);

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
          onMove={(to, way) => move(to, way, search.open)}
          stepId={current}
          steps={steps}
        />
      )}
    </motion.div>
  );
}

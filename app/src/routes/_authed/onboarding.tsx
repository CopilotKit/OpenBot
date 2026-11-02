import { WEB_HARNESSES } from "@openbot/shared/harnesses";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import Avatar from "boring-avatars";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import * as React from "react";
import useMeasure from "react-use-measure";
import { HarnessMark } from "@/components/agents/harness-mark";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { Composer } from "@/components/channels/composer";
import { DesktopIllustration } from "@/components/computer/desktop-illustration";
import { ComputerPlaceholder } from "@/components/computer/placeholder";
import { SELF_HOST_URL } from "@/components/layout/self-host-banner";
import { IllustrationFrame } from "@/components/onboarding/illustration-frame";
import { IntroAnimation } from "@/components/onboarding/intro-animation";
import { LaptopIllustration } from "@/components/onboarding/laptop-illustration";
import { OrganizationFlow } from "@/components/onboarding/organization-flow";
import { OnboardingNameStep } from "@/components/settings/profile";
import { Button, buttonVariants } from "@/components/ui/button";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions, needsOnboarding } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { appConfig } from "@/lib/generated/application-config";
import { completeOnboardingMutationOptions } from "@/lib/onboarding/mutations";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/onboarding")({
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

function WelcomeStep() {
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center">
        Welcome to {appConfig.brand.productName}
      </h1>
      <div className="h-8" />
      <IllustrationFrame
        className="flex flex-col items-center px-8 pt-16 pb-10"
        label="A message box where you hand off tasks to your Bots"
      >
        <AgentOrb size="72px" />
        {/*
         * A POSTER OF A COMPOSER, AND THE FRAME AROUND IT IS WHAT MAKES IT ONE: `IllustrationFrame` is
         * `pointer-events-none` and `inert`. Nothing here is
         * meant to be typed in, clicked or dropped on: it is a picture of the thing the person is
         * about to get, shown while they read a sentence about it.
         *
         * THE DROP THAT PASSES STRAIGHT THROUGH IT IS SOMEBODY ELSE'S TO CATCH, WHICH IS WORTH
         * SAYING OUT LOUD. The composer guards its own form against a dropped file navigating the
         * whole app away (`refuseDragOver` in `composer.tsx`), and that guard cannot fire here: an
         * element with no pointer events is never the target of the drop, so the event goes past it
         * to the document as if this composer were not on the page. What catches it is
         * `useUnclaimedDropGuard` in `routes/__root.tsx`, which refuses every drop nobody claimed —
         * the reason that guard lives at the root rather than in the composer, and the reason this
         * wrapper does not need to change to be safe. Taking `pointer-events-none` off to "fix" the
         * drop would turn the poster back into a live composer with nowhere to upload to.
         */}
        <div className="max-w-md w-full mx-auto mt-10">
          <Composer
            compact
            className="scale-90"
            editorClassName="text-base"
            initialValue="Hand off tasks to your team of Bots"
          />
        </div>
      </IllustrationFrame>
    </div>
  );
}

function ComputerUseStep() {
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center">
        Each Bot has its own browser and files
      </h1>
      <div className="h-8" />
      <div className="relative aspect-5/3 w-full max-w-lg rounded-2xl overflow-hidden border border-border">
        <ComputerPlaceholder className="absolute inset-0 h-full w-full" />
        <DesktopIllustration />
      </div>
    </div>
  );
}

/** What a roster card needs — placeholders carry these three fields and nothing more. */
type RosterCard = Pick<AgentProfile, "id" | "name" | "avatarSeed">;

/**
 * Stand-ins for a deployment that has fewer than three public agents to show. Invented names on
 * purpose: they illustrate what a roster looks like without claiming any of these exist here.
 */
const AGENTS_PLACEHOLDER: RosterCard[] = [
  {
    id: "placeholder-research",
    name: "Research Analyst",
    avatarSeed: "research-analyst",
  },
  { id: "placeholder-data", name: "Data Analyst", avatarSeed: "data-analyst" },
  {
    id: "placeholder-support",
    name: "Support Desk",
    avatarSeed: "support-agent",
  },
];

function RosterStep() {
  const { data: agents } = useQuery(agentListQueryOptions());
  const explore =
    agents?.filter((a) => !a.mine && a.visibility === "public") ?? [];
  // Always three cards: real public agents first, placeholders topping up a sparse deployment.
  // slice past the end is just [], so a roster of three or more takes no placeholders at all.
  const roster: Array<RosterCard & { example?: boolean }> = [
    ...explore.slice(0, 3),
    ...AGENTS_PLACEHOLDER.slice(explore.length).map((placeholder) => ({
      ...placeholder,
      example: true,
    })),
  ];

  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center">
        Pick a Bot or make your own
      </h1>
      <div className="h-8" />
      <IllustrationFrame
        className="grid grid-cols-1 md:grid-cols-2 gap-4 p-6"
        label={`Bots you can work with, such as ${roster.map((a) => a.name).join(", ")}, and one of your own`}
      >
        {roster.map((a) => {
          return (
            <div
              key={a.id}
              // Dimmed and labelled, so an invented name never reads as a Bot this deployment has.
              className={`bg-card p-4 rounded-lg flex flex-row gap-4 items-center ${a.example ? "opacity-70" : ""}`}
            >
              <Avatar name={a.avatarSeed} size={40} />
              <div className="flex min-w-0 flex-col">
                <h3 className="line-clamp-1 text-base font-medium tracking-tight">
                  {a.name}
                </h3>
                {a.example ? (
                  <span className="text-xs text-muted-foreground">Example</span>
                ) : null}
              </div>
            </div>
          );
        })}
        <div className="bg-card p-4 rounded-lg flex flex-row gap-4 items-center">
          <div className="rounded-full size-[40px] border border-foreground/30 border-dashed" />
          <h3 className="line-clamp-1 text-base font-medium tracking-tight text-foreground/70">
            Your own Bot
          </h3>
        </div>
      </IllustrationFrame>
    </div>
  );
}

/*
 * These local-evaluation scenes are for somebody trying OpenBot on their own machine
 * (see `localEvaluation` in RouteComponent). They answer what that person is deciding: where their
 * data is, whether their own agents fit, and what taking it to their organization involves (OB-02 in
 * the product backlog). None of it is said to an organization's own people, who are past all three.
 */

function LocalStep() {
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center">
        It runs on your machine
      </h1>
      {/*
       * "Stored", and the model named, because "your data never leaves" would be untrue: every turn
       * goes to the model provider this install was set up with. What stays is everything kept. No
       * word about sign-in either: activating a local install signs you in to CopilotKit.
       */}
      <p className="mt-3 max-w-md text-center text-muted-foreground">
        Your conversations, files and Bots are stored on this computer. Only
        what you send to your model leaves it.
      </p>
      <div className="h-8" />
      <IllustrationFrame
        className="flex items-center justify-center px-8 py-12"
        label={`A laptop running ${appConfig.brand.productName}`}
      >
        <LaptopIllustration />
      </IllustrationFrame>
    </div>
  );
}

/** Every framework the New Bot wizard offers by name; "an agent you already run" is the sentence. */
const FRAMEWORKS = WEB_HARNESSES.filter((harness) => harness.id !== "byo-url");

function AgentsStep() {
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center">
        Bring the agents you already have
      </h1>
      <p className="mt-3 max-w-md text-center text-muted-foreground">
        Any AG-UI agent can join as a Bot. Add one from Bots, then New Bot.
      </p>
      <div className="h-8" />
      <IllustrationFrame
        className="flex flex-wrap justify-center gap-2 p-6"
        label={`Frameworks that work as Bots: ${FRAMEWORKS.map((harness) => harness.name).join(", ")}`}
      >
        {FRAMEWORKS.map((harness) => (
          <span
            className="flex items-center gap-2 rounded-full bg-card px-3 py-1.5 text-sm"
            key={harness.id}
          >
            <HarnessMark id={harness.mark} name={harness.name} />
            {harness.name}
          </span>
        ))}
      </IllustrationFrame>
    </div>
  );
}

function OrganizationStep() {
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center">
        Deploy it for your organization
      </h1>
      <p className="mt-3 max-w-md text-center text-muted-foreground">
        Run one container image, or a Helm chart for EKS, GKE or AKS. Your
        people sign in with Google, Microsoft or Okta.
      </p>
      <div className="h-8" />
      <IllustrationFrame
        className="flex justify-center px-6 py-8"
        label="Your people sign in with Google, Microsoft or Okta, and your organization gets its own rules, its own Bots and an audit trail"
      >
        <OrganizationFlow />
      </IllustrationFrame>
      {/*
       * The one real control on these slides, so it sits outside the frame: a frame means picture.
       * A new tab, because following it must not cost this person their place in onboarding.
       */}
      <a
        className={cn(buttonVariants({ variant: "outline" }), "mt-6")}
        href={SELF_HOST_URL}
        rel="noopener noreferrer"
        target="_blank"
      >
        Talk to an engineer
      </a>
    </div>
  );
}

function Introduction({ localEvaluation }: { localEvaluation: boolean }) {
  return (
    <IntroAnimation
      scenes={[
        { id: "welcome", label: "Welcome", content: <WelcomeStep /> },
        {
          id: "computer",
          label: "Each Bot has its own browser and files",
          content: <ComputerUseStep />,
        },
        {
          id: "roster",
          label: "Pick a Bot or make your own",
          content: <RosterStep />,
        },
        ...(localEvaluation
          ? [
              {
                id: "local",
                label: "It runs on your machine",
                content: <LocalStep />,
              },
              {
                id: "agents",
                label: "Bring the agents you already have",
                content: <AgentsStep />,
              },
            ]
          : []),
      ]}
    />
  );
}

/** A pane arrives from the side the journey is moving toward, and leaves out the other. */
const variants = {
  initial: (direction: number) => ({ x: `${110 * direction}%`, opacity: 0 }),
  active: { x: "0%", opacity: 1 },
  exit: (direction: number) => ({ x: `${-110 * direction}%`, opacity: 0 }),
};

function RouteComponent() {
  const navigate = useNavigate();
  const complete = useMutation(completeOnboardingMutationOptions(queryClient));

  // Browser state on purpose: the step is not persisted while the wizard is being designed.
  const [step, setStep] = React.useState<"intro" | "organization" | "name">(
    "intro",
  );
  const [direction, setDirection] = React.useState(1);
  // The way out: set once the completion is saved, it fades the whole page and then navigates.
  const [leaving, setLeaving] = React.useState(false);
  const [ref, bounds] = useMeasure();

  /*
   * Local-evaluation content is never shown to an organization's people:
   * the server says single-user mode, which an organization's deployment, always behind sign-in,
   * cannot be in. Until the answer arrives they are left out, so a slow or failed request never
   * shows an organization's employees a page about deploying OpenBot themselves.
   *
   * NOT GATED ON `selfHostBanner` AS WELL. That flag is off for any deployment with a paid
   * Intelligence entitlement, and the stack `copilotkit local` installs runs on an enterprise
   * evaluation licence, so every CLI evaluator, the person these slides are for, would never see them.
   */
  const {
    data: capabilities,
    error: capabilitiesError,
    refetch: retryCapabilities,
    isFetching: loadingCapabilities,
  } = useQuery(deploymentCapabilitiesQueryOptions());
  const localEvaluation = capabilities?.localEvaluation === true;
  const last = step === "name";

  const go = (to: typeof step, forward: boolean) => {
    setDirection(forward ? 1 : -1);
    setStep(to);
  };

  return (
    // Outside `_app` on purpose: no sidebar and no chrome until onboarding is done.
    // The fade runs only after the completion is saved, so a failed save never fades a page the
    // person still needs — and navigation waits for the fade, so the home screen never pops in
    // over a half-faded wizard.
    <motion.div
      animate={{ opacity: leaving ? 0 : 1 }}
      className={`min-h-svh overflow-hidden flex flex-col items-center justify-center w-full ${leaving ? "pointer-events-none" : ""}`}
      initial={false}
      onAnimationComplete={() => {
        if (leaving) {
          navigate({ to: "/" });
        }
      }}
      transition={{ duration: 0.5, ease: "easeInOut" }}
    >
      <div className="mx-auto w-full max-w-2xl px-4">
        <MotionConfig transition={{ duration: 0.5, type: "spring", bounce: 0 }}>
          {/* The frame follows each pane's height, so the buttons glide instead of jumping. */}
          <motion.div
            animate={{ height: bounds.height > 0 ? bounds.height : "auto" }}
            className="overflow-hidden"
          >
            <div ref={ref}>
              <AnimatePresence
                custom={direction}
                initial={false}
                mode="popLayout"
              >
                <motion.div
                  animate="active"
                  custom={direction}
                  exit="exit"
                  initial="initial"
                  key={step}
                  variants={variants}
                >
                  {step === "intro" && (
                    <Introduction localEvaluation={localEvaluation} />
                  )}
                  {step === "organization" && <OrganizationStep />}
                  {step === "name" && (
                    <OnboardingNameStep
                      onSaved={async () => {
                        await complete.mutateAsync(undefined);
                        setLeaving(true);
                      }}
                    />
                  )}
                </motion.div>
              </AnimatePresence>

              {capabilitiesError && !capabilities ? (
                <div className="mt-4 text-center">
                  <p className="text-sm text-destructive" role="alert">
                    We couldn't load your setup. Try again to continue.
                  </p>
                  <Button
                    variant="ghost"
                    disabled={loadingCapabilities}
                    onClick={() => retryCapabilities()}
                  >
                    Try again
                  </Button>
                </div>
              ) : null}

              {complete.error ? (
                <p className="mt-4 text-destructive text-sm" role="alert">
                  {complete.error.message}
                </p>
              ) : null}

              <motion.div
                className={`${last ? "mt-4" : "mt-8"} flex flex-col items-center justify-center max-w-xs gap-4 w-full mx-auto`}
                layout
              >
                {!last && (
                  <Button
                    className="w-full"
                    disabled={complete.isPending || !capabilities}
                    onClick={() =>
                      go(
                        step === "intro" && localEvaluation
                          ? "organization"
                          : "name",
                        true,
                      )
                    }
                    size="lg"
                  >
                    Continue
                  </Button>
                )}
                {step !== "intro" && (
                  <Button
                    className="w-full"
                    disabled={complete.isPending}
                    onClick={() =>
                      go(
                        step === "name" && localEvaluation
                          ? "organization"
                          : "intro",
                        false,
                      )
                    }
                    variant="secondary"
                    size="lg"
                  >
                    Back
                  </Button>
                )}
              </motion.div>
            </div>
          </motion.div>
        </MotionConfig>
      </div>
    </motion.div>
  );
}

import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useSignOut } from "@/components/app-sidebar/use-sign-out";
import { IntroReel } from "@/components/onboarding/demos/intro-reel";
import { StepIntro } from "@/components/onboarding/onboarding-frame";
import {
  type OnboardingStep,
  OnboardingWizard,
} from "@/components/onboarding/onboarding-wizard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Item, ItemContent, ItemMedia } from "@/components/ui/item";
import { ClientError } from "@/lib/client";
import { appConfig } from "@/lib/generated/application-config";
import { loadFailure } from "@/lib/load-failure";
import { acceptServiceTermsMutationOptions } from "@/lib/service-terms/mutations";
import {
  afterTerms,
  type ServiceTerms,
  serviceTermsQueryOptions,
  serviceTermsRequired,
} from "@/lib/service-terms/queries";
import { queryClient } from "@/query-client";

const PRODUCT = appConfig.brand.productName;

export const Route = createFileRoute("/_authed/terms")({
  /*
   * `?next=` is where the person was headed when the gate brought them here, and where agreeing
   * takes them (`afterTerms` follows only a path in this app). Named even when absent, so a key
   * left out never keeps whatever was typed into the address.
   */
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
  // Somebody with nothing to agree to has no business here: on to where they were headed.
  beforeLoad: async ({ context, search }) => {
    if (!(await serviceTermsRequired(context.queryClient)))
      throw redirect({ href: afterTerms(search.next), replace: true });
  },
  component: TermsScreen,
});

/**
 * THE TERMS, BEFORE ANYTHING ELSE. On OpenBot Cloud a person agrees to the Terms of Service and the
 * Acceptable Use Policy before they use it, and again whenever the version changes. The signed-in
 * gate (`_authed`) sends them here from anywhere until they do.
 *
 * Drawn as onboarding's first step, in its frame, so it reads as part of signing up rather than a
 * wall in front of it. One step: no step list and no Back. The box starts unticked and Continue
 * waits for it. Both names open in a new tab, which OpenBot Desktop opens in the person's browser.
 * Sign out is the way out for somebody who won't agree.
 *
 * The tick is for one version: it is kept as the version ticked, so terms that change while the
 * screen is open (the server refuses with SERVICE_TERMS_CHANGED, and the terms are read again)
 * show unticked, with the server's sentence saying why.
 *
 * Once the server says there is nothing left to agree to, the person goes on to where they were
 * headed, or home, which hands a new person to onboarding as before.
 */
function TermsScreen() {
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const terms = useQuery(serviceTermsQueryOptions());
  const accept = useMutation(acceptServiceTermsMutationOptions(queryClient));
  const signOut = useSignOut();
  const [agreedTo, setAgreedTo] = React.useState<string | null>(null);

  const agreed = terms.data?.acceptanceNeeded === false;
  React.useEffect(() => {
    if (agreed) void navigate({ href: afterTerms(next), replace: true });
  }, [agreed, navigate, next]);

  if (terms.isPending || agreed) return null;

  const current = terms.data?.current ?? null;
  const checked = current !== null && agreedTo === current.version;
  // Somebody who agreed to an earlier version is told what changed, not welcomed again.
  const changed = Boolean(terms.data?.accepted);

  const failed = terms.error && !terms.data;
  const notice = failed ? (
    <div className="flex flex-col items-center gap-1 lg:items-start">
      <p
        className="text-sm text-center text-destructive lg:text-left"
        role="alert"
      >
        {loadFailure(
          terms.error,
          "Couldn't load the terms. Try again to continue.",
        )}
      </p>
      <Button
        disabled={terms.isFetching}
        onClick={() => void terms.refetch()}
        size="sm"
        variant="ghost"
      >
        Try again
      </Button>
    </div>
  ) : accept.error ? (
    <p
      className="text-sm text-center text-destructive lg:text-left"
      role="alert"
    >
      {refusalSentence(accept.error)}
    </p>
  ) : undefined;

  const step: OnboardingStep = {
    id: "terms",
    title: changed ? "The terms have changed" : "Agree to the terms",
    intro: () => (
      <StepIntro
        after={
          current ? (
            <AgreeBox
              checked={checked}
              current={current}
              onChange={(next) => {
                accept.reset();
                setAgreedTo(next ? current.version : null);
              }}
            />
          ) : undefined
        }
      >
        <p>
          {changed
            ? `Read the new version and agree to it to keep using ${PRODUCT}.`
            : `Read the terms for using ${PRODUCT}, then agree to them to continue.`}
        </p>
      </StepIntro>
    ),
    demo: () => <IntroReel computer />,
    primaryLabel: "Continue",
    primaryDisabled: !checked,
    primaryPending: accept.isPending,
    onPrimary: () => {
      if (current && checked) accept.mutate(current.version);
    },
    secondary: {
      label: signOut.pending ? "Signing out…" : "Sign out",
      onClick: signOut.run,
    },
    notice,
  };

  return (
    // Outside `_app` like onboarding: no sidebar and no chrome until the person is in.
    <div className="min-h-svh w-full">
      <OnboardingWizard stepId="terms" steps={[step]} />
    </div>
  );
}

/**
 * The one control: a tickbox and the sentence it agrees to, in the outlined row Welcome's switch
 * sits in. The sentence is the tickbox's label, so pressing it ticks the box; the two names are
 * links inside it, which open their page and leave the box as it was.
 */
function AgreeBox({
  current,
  checked,
  onChange,
}: {
  current: NonNullable<ServiceTerms["current"]>;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  // Each name kept on one line, so a narrow screen never breaks one in two.
  const link =
    "font-medium whitespace-nowrap text-foreground underline underline-offset-4 hover:text-primary";
  return (
    <Item className="text-left" size="sm" variant="outline">
      <ItemMedia className="self-start pt-0.5">
        <Checkbox
          aria-required
          checked={checked}
          data-terms-agree=""
          id="terms-agree"
          onCheckedChange={(next) => onChange(next === true)}
        />
      </ItemMedia>
      <ItemContent>
        <label
          className="text-sm leading-snug text-pretty cursor-pointer"
          htmlFor="terms-agree"
        >
          I agree to the{" "}
          <a
            className={link}
            href={current.termsOfServiceUrl}
            rel="noreferrer"
            target="_blank"
          >
            Terms of Service
          </a>{" "}
          and{" "}
          <a
            className={link}
            href={current.acceptableUseUrl}
            rel="noreferrer"
            target="_blank"
          >
            Acceptable Use Policy
          </a>
        </label>
      </ItemContent>
    </Item>
  );
}

/**
 * What a refused agreement says. Terms that changed while the screen was open are said in the
 * server's own sentence, over the new version; anything else in the screen's own words.
 */
function refusalSentence(error: Error): string {
  if (error instanceof ClientError && error.code === "SERVICE_TERMS_CHANGED")
    return error.message;
  return "Couldn't save that you agreed. Try again.";
}

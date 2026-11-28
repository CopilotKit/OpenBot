import { IconBuilding, IconChevronRight } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { Trademark } from "@/components/edition/brand-name";
import {
  openTeamFeatures,
  TeamFeaturesDialog,
} from "@/components/edition/team-features-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { hostedSignInAddress } from "@/lib/auth/hosted";
import { resumeUrlFor } from "@/lib/auth/resume";
import { cn } from "@/lib/utils";

/** The sign-in screen's heading on OpenBot Cloud. */
export const CLOUD_SIGN_IN_TITLE = "Sign in to OpenBot Cloud";

/** Under the heading: who runs it, and that signing in is also how somebody new starts. */
export const CLOUD_SIGN_IN_LINE =
  "We run OpenBot for you. New here? Signing in creates your account.";

/**
 * Under the button that creates the account: how a new one starts, on a free trial measured by use.
 * Never the number of runs.
 */
export const CLOUD_TRIAL_LINE =
  "New accounts start on a free usage-based trial.";

/** OpenBot for Business, in the words OpenBot Desktop's first screen gives it. */
export const BUSINESS_SUMMARY = "Your own cloud or on-prem. Book a demo.";

/** The field for a company's own OpenBot, in words anybody can follow. */
export const COMPANY_ADDRESS_LABEL = "Your company's OpenBot address";
export const COMPANY_ADDRESS_HELP =
  "Ask your IT team or whoever set up OpenBot at your company for this address.";

/** The trial line, with "usage-based" held on one line so it never breaks at the hyphen. */
function trialLineWords() {
  const [before, after] = CLOUD_TRIAL_LINE.split("usage-based");
  return (
    <>
      {before}
      <span className="whitespace-nowrap">usage-based</span>
      {after}
    </>
  );
}

/** How the page leaves for another OpenBot's address. A test replaces it to see where it was sent. */
export const cloudSignInDeps = {
  open: (address: string) => window.location.assign(address),
};

/**
 * The typed address of a company's own OpenBot, as an address the browser can open, or null when it
 * is not one. No scheme is read as https, as OpenBot Desktop reads it.
 */
export function companyOpenBotAddress(typed: string): URL | null {
  const trimmed = typed.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.hostname.length === 0) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * What OpenBot Cloud's signed-out screen offers, under its heading: signing in to OpenBot Cloud,
 * and OpenBot for Business for a company that runs OpenBot itself.
 *
 * Signing in is the hosted sign-in (`hostedSignInAddress`), which takes any email address and makes
 * an account for somebody new, so it is the one primary button. OpenBot for Business opens the app's
 * OpenBot for Business dialog, the same words and booking calendar OpenBot Desktop's first screen
 * shows (`shared/openbot-for-business`). Somebody whose company already runs OpenBot types its
 * address and the browser goes there, to sign in on that OpenBot.
 *
 * Only on OpenBot Cloud (`hostedSignIn`). An OpenBot a company runs itself keeps its own sign-in
 * screen, and nothing here mentions installing OpenBot on a computer.
 */
export function CloudSignIn({ flowId }: { flowId?: string }) {
  const [opening, setOpening] = useState(false);
  const [goingElsewhere, setGoingElsewhere] = useState(false);
  return (
    <div className="flex w-full flex-col">
      <p className="text-pretty text-center text-muted-foreground text-sm">
        {CLOUD_SIGN_IN_LINE}
      </p>
      {/*
       * A link that looks like the primary button: the server takes the browser on to the hosted
       * sign-in and back to where sign-in would have brought them, with `?flow_id=` carried through.
       */}
      <a
        aria-disabled={opening || undefined}
        className={cn(
          buttonVariants({ size: "lg" }),
          "mt-6 h-10 w-full tracking-tight",
          opening && "pointer-events-none opacity-50",
        )}
        href={hostedSignInAddress(resumeUrlFor(window.location.origin, flowId))}
        onClick={() => setOpening(true)}
      >
        {opening ? "Opening sign-in…" : "Sign in or create an account"}
      </a>
      {/*
       * Its own short line, so the line under the heading keeps its two lines; and "usage-based"
       * is never split at its hyphen, at any width.
       */}
      <p
        className="mt-3 text-balance text-center text-muted-foreground text-xs"
        data-testid="cloud-trial-line"
      >
        {trialLineWords()}
      </p>
      <div className="my-6 flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-muted-foreground text-xs">or</span>
        <Separator className="flex-1" />
      </div>
      {/*
       * The whole row opens the dialog. The element given to `render` has no children of its own.
       * Its border, fill and hover are the outline button's, as the sign-in screen's other choices
       * are drawn: an outline row is borderless in dark mode by itself.
       */}
      <Item
        className="text-left hover:bg-muted dark:border-input dark:bg-input/30 dark:hover:bg-input/50"
        render={
          <button onClick={() => openTeamFeatures("sign_in")} type="button" />
        }
        size="sm"
        variant="outline"
      >
        <ItemMedia variant="icon">
          <IconBuilding />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>
            <span>
              OpenBot for Business
              <Trademark />
            </span>
          </ItemTitle>
          <ItemDescription>{BUSINESS_SUMMARY}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      {goingElsewhere ? (
        <GoToCompanyOpenBot />
      ) : (
        <p className="mt-4 text-center text-muted-foreground text-sm">
          Already have OpenBot at work?{" "}
          <button
            className="underline underline-offset-4 hover:text-foreground"
            onClick={() => setGoingElsewhere(true)}
            type="button"
          >
            Go to it
          </button>
          .
        </p>
      )}
      <TeamFeaturesDialog />
    </div>
  );
}

/**
 * The address of the OpenBot a company runs itself, and the way there: the browser leaves for that
 * address, where the person signs in to their company's OpenBot. Nothing is checked from here, since
 * this page can't ask another OpenBot anything before the person is on it.
 */
function GoToCompanyOpenBot() {
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  // Focused as it appears: it is what the link above asked for.
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  return (
    <form
      className="mt-4 flex flex-col"
      noValidate
      onSubmit={(submission) => {
        submission.preventDefault();
        const url = companyOpenBotAddress(address);
        if (url === null) {
          setProblem(
            "Enter your company's OpenBot address, such as openbot.example.com.",
          );
          return;
        }
        if (url.origin === window.location.origin) {
          setProblem("That's OpenBot Cloud. Sign in above.");
          return;
        }
        setProblem(null);
        setLeaving(true);
        cloudSignInDeps.open(url.href);
      }}
    >
      <Label className="mb-2" htmlFor="company-openbot-address">
        {COMPANY_ADDRESS_LABEL}
      </Label>
      <Input
        aria-describedby={
          problem
            ? "company-openbot-help company-openbot-problem"
            : "company-openbot-help"
        }
        aria-invalid={problem ? true : undefined}
        autoCapitalize="none"
        autoComplete="url"
        autoCorrect="off"
        id="company-openbot-address"
        inputMode="url"
        onChange={(event) => {
          setAddress(event.target.value);
          setProblem(null);
        }}
        placeholder="openbot.example.com"
        ref={field}
        spellCheck={false}
        type="text"
        value={address}
      />
      <p
        className="mt-2 text-pretty text-muted-foreground text-xs"
        id="company-openbot-help"
      >
        {COMPANY_ADDRESS_HELP}
      </p>
      {problem ? (
        <p
          className="mt-2 text-destructive text-sm"
          id="company-openbot-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <Button
        className="mt-2 h-10 w-full tracking-tight"
        disabled={leaving || address.trim().length === 0}
        size="lg"
        type="submit"
        variant="outline"
      >
        {leaving ? "Opening…" : "Go to your company's OpenBot"}
      </Button>
    </form>
  );
}

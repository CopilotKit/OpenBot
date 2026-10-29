import { useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { attentionSummary } from "@/components/bot-profile/attention";
import { appConfig } from "@/lib/generated/application-config";
import {
  requestNotificationPermission,
  useNotificationPermission,
} from "@/lib/notifications/permission";
import { StepIntro } from "./onboarding-frame";
import type { OnboardingStep } from "./onboarding-wizard";

const PRODUCT = appConfig.brand.productName;

/** How long "Notifications on" shows before the step moves on by itself. */
export const GRANTED_BEAT_MS = 1_000;

/**
 * The notification the preview shows: the one this web app raises today, word for word.
 *
 * `AttentionNotifier` (`bot-profile/attention.tsx`) titles it "<Bot> needs you" and says what is
 * waiting with `attentionSummary`, which is called here so the body cannot drift from it. A Bot with
 * a question and an approval waiting is the common case it fires for.
 */
export function notificationPreview(botName: string): {
  title: string;
  body: string;
} {
  return {
    title: `${botName} needs you`,
    body: attentionSummary({
      agentId: "preview",
      name: botName,
      questions: 1,
      approvals: 1,
      handoffs: 0,
      unread: 0,
      paused: false,
      notify: "all",
    }),
  };
}

/**
 * Onboarding's Get notified step: a preview of the notification, and the button that asks the
 * browser for permission.
 *
 * Its buttons are the frame's, so this returns the whole step. "Turn on notifications" asks the
 * browser, and shows a spinner while its prompt is up. A yes turns the button green, "Notifications
 * on", for a beat and then moves on by itself. A no, a prompt closed without an answer, or a
 * browser with no notifications at all says so on the step, and the button becomes Continue. "Not
 * now" moves on and asks nothing. The step is optional, so the button keeps its place when Not now
 * goes.
 */
export function useNotifyStep(botName: string): OnboardingStep {
  const permission = useNotificationPermission();
  const [asking, setAsking] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const granted = permission === "granted";
  // Answered, or nothing to ask: the button only moves on from here.
  const done =
    permission === "denied" || permission === "unsupported" || dismissed;

  /*
   * Why the button now says Continue, said just above it in the frame's notice slot rather than
   * beside the preview: on a small screen the preview pushes anything under it out of view, and the
   * person would see the button change with no reason.
   */
  const said =
    permission === "denied"
      ? "Notifications are blocked for this site. Allow them in your browser's site settings to turn them on."
      : permission === "unsupported"
        ? "This browser can't show notifications."
        : dismissed && permission === "default"
          ? "You can turn them on later from a Bot's page."
          : null;

  return {
    id: "notify",
    title: "Get notified",
    intro: () => (
      <StepIntro title="Get notified">
        <p>
          Allow notifications so {PRODUCT} can tell you when a Bot needs you.
        </p>
      </StepIntro>
    ),
    demo: () => <NotifyPreview botName={botName} />,
    notice: said ? (
      <p
        className="type-sub text-center text-muted-foreground lg:text-left"
        role="status"
      >
        {said}
      </p>
    ) : undefined,
    optional: true,
    primaryLabel: granted
      ? "Notifications on"
      : done
        ? "Continue"
        : "Turn on notifications",
    primaryDone: granted,
    primaryPending: asking,
    onPrimary:
      granted || done
        ? undefined
        : (next) => {
            setAsking(true);
            void requestNotificationPermission().then((answer) => {
              setAsking(false);
              if (answer === "granted") setTimeout(next, GRANTED_BEAT_MS);
              // The prompt closed with neither answer: the browser still says "default".
              else if (answer === "default") setDismissed(true);
            });
          },
    secondary: granted || done ? undefined : { label: "Not now" },
    footnote: `Notifications show while ${PRODUCT} is open in a browser tab.`,
  };
}

/**
 * A ghost phone, so the card reads as something arriving on a screen: taller than it is wide, its
 * top fading out rather than drawn, the notification over it and four app tiles under it.
 */
function NotifyPreview({ botName }: { botName: string }) {
  const preview = notificationPreview(botName);
  return (
    <div className="flex justify-center">
      <div
        aria-label={`A notification from ${PRODUCT}: ${preview.title}. ${preview.body}.`}
        className="relative flex h-[380px] w-[300px] max-w-full flex-col items-center"
        data-ghost-phone=""
        role="img"
      >
        <div
          aria-hidden
          className="absolute inset-0 rounded-[46px] bg-linear-to-b from-background to-muted shadow-[inset_0_0_0_1.5px_var(--border)] [mask-image:linear-gradient(to_bottom,transparent,black_38%)]"
        />
        <div
          aria-hidden
          className="relative mt-[120px] flex w-[272px] max-w-[calc(100%-24px)] items-center gap-3 rounded-[20px] bg-card px-3 py-3 shadow-(--shadow-raised)"
          data-notification-preview=""
        >
          <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-muted">
            <AgentOrb size="30px" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="type-sub truncate font-semibold text-foreground">
                {preview.title}
              </span>
              <span className="type-caption shrink-0 text-muted-foreground">
                now
              </span>
            </span>
            <span className="type-sub block truncate text-muted-foreground">
              {preview.body}
            </span>
          </span>
        </div>
        <div aria-hidden className="relative mt-14 flex gap-3">
          {[0, 1, 2, 3].map((tile) => (
            <span
              className="size-[52px] rounded-[14px] bg-card/80 shadow-[inset_0_0_0_1px_var(--border)]"
              key={tile}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

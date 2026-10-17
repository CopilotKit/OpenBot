import { type CapturedEvent, scrubUrl } from "@openbot/shared/recorder-masking";
import type { DemonstrationAction } from "@openbot/shared/demonstration-schema";
import { safeDemonstrationUrl } from "@openbot/shared/demonstration-rules";

export type NavigationDetails = {
  tabId: number;
  frameId: number;
  parentFrameId?: number;
  url: string;
  transitionType?: string;
  transitionQualifiers?: string[];
  timeStamp?: number;
};

type NavigationKind = "commit" | "history";
type NavigationType = "push" | "replace" | "traverse" | "reload";
type NavigateTransition = Extract<
  DemonstrationAction,
  { kind: "navigate" }
>["transition"];

const TRANSITIONS: Record<string, NavigateTransition> = {
  link: "link",
  typed: "typed",
  reload: "reload",
  form_submit: "form_submit",
};

function goesBackOrForward(details: NavigationDetails): boolean {
  return details.transitionQualifiers?.includes("forward_back") ?? false;
}

function navigationType(
  details: NavigationDetails,
  kind: NavigationKind,
): NavigationType {
  if (kind === "history") return "push";
  if (goesBackOrForward(details)) return "traverse";
  if (details.transitionType === "reload") return "reload";
  return "push";
}

/** The collector's navigation event, for a commit or a history update in any frame. */
export function navigationEvent(
  details: NavigationDetails,
  kind: NavigationKind,
  fromUrl: string | undefined,
): CapturedEvent {
  return {
    type: "CUSTOM",
    name: "navigation",
    timestamp: details.timeStamp ?? Date.now(),
    value: {
      from: fromUrl === undefined ? "" : scrubUrl(fromUrl),
      to: scrubUrl(details.url),
      navigationType: navigationType(details, kind),
      frameId: details.frameId,
      parentFrameId: details.parentFrameId ?? (details.frameId === 0 ? -1 : 0),
    },
  };
}

/** A navigate step for the top frame only: a sub-frame's navigation is not something the Bot repeats. */
export function navigateStep(
  details: NavigationDetails,
  kind: NavigationKind,
): DemonstrationAction | null {
  if (details.frameId !== 0) return null;
  let transition: NavigateTransition;
  if (kind === "history") transition = "history";
  else if (goesBackOrForward(details)) transition = "back_forward";
  else transition = TRANSITIONS[details.transitionType ?? ""] ?? "other";
  return {
    kind: "navigate",
    url: safeDemonstrationUrl(details.url),
    transition,
  };
}

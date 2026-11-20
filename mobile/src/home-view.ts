/**
 * Which Home the person sees: the sign-in screen, the one for somebody signed in who is in no organization here, or
 * the app. Somebody in no organization (never added, or removed from the last one) is told so and offered only what
 * acts on no organization: trying again, and signing out. It imports nothing that needs a phone, so it can be tested.
 */
import { IN_NO_ORGANIZATION } from "./organization";

export type HomeView = "signed-out" | "in-no-organization" | "working";

/** `organizationsError` is what reading the person's organizations failed with, if it did. */
export function homeView(
  signedIn: boolean,
  organizationsError: string | undefined,
): HomeView {
  if (!signedIn) return "signed-out";
  return organizationsError === IN_NO_ORGANIZATION
    ? "in-no-organization"
    : "working";
}

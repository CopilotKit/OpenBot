/**
 * Which Home the person sees: the sign-in screen, the one for somebody signed in who is in no organization here, the one
 * for somebody the organization they work in holds out until they sign in through their company, or the app.
 * Somebody in no organization (never added, or removed from the last one) is told so and offered only what acts on no
 * organization: trying again, and signing out. Somebody held out is offered the way in (Link your company account), their
 * other organizations, and signing out. It imports nothing that needs a phone, so it can be tested.
 */
import { heldOut } from "./company-sign-in";
import { IN_NO_ORGANIZATION } from "./organization";

export type HomeView =
  | "signed-out"
  | "in-no-organization"
  | "held-out"
  | "working";

/**
 * `organizationsError` is what reading the person's organizations failed with, if it did. `companySignIn` is whether the
 * organization they work in requires company sign-in and whether they have, once read.
 */
export function homeView(
  signedIn: boolean,
  organizationsError: string | undefined,
  companySignIn?: { required: boolean; met: boolean },
): HomeView {
  if (!signedIn) return "signed-out";
  if (organizationsError === IN_NO_ORGANIZATION) return "in-no-organization";
  return heldOut(companySignIn) ? "held-out" : "working";
}

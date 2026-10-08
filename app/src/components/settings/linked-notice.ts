export type LinkedNotice = { tone: "success" | "error"; text: string };

/**
 * What the connected accounts page says about the `?linked=` the GitHub callback redirected back
 * with. Only the three values the callback sends have a sentence; anything else says nothing.
 */
export function linkedNotice(value: string | undefined): LinkedNotice | null {
  if (value === "github") {
    return { tone: "success", text: "Your GitHub account is linked." };
  }
  if (value === "failed") {
    return {
      tone: "error",
      text: "That account could not be linked. Nothing was saved — try again.",
    };
  }
  if (value === "github-taken") {
    return {
      tone: "error",
      text: "That GitHub account is already linked to another OpenBot user. Disconnect it there first, or connect a different GitHub account.",
    };
  }
  return null;
}

/**
 * The notice to draw right now, given the person's current linked accounts.
 *
 * A success notice is a claim about the list below it, so it holds only while that list agrees: the
 * only success `linkedNotice` produces is for GitHub, and once that link is gone (the person
 * disconnected it on this very page) the sentence would contradict the card under it. Until the list
 * has loaded (`links` undefined) it stays hidden, which beats flashing a claim that may be wrong.
 * Error notices describe an attempt, not the list, so they are never withheld.
 */
export function visibleLinkedNotice(
  notice: LinkedNotice | null,
  links: ReadonlyArray<{ provider: string }> | undefined,
): LinkedNotice | null {
  if (!notice || notice.tone === "error") return notice;
  return links?.some((link) => link.provider === "github") ? notice : null;
}

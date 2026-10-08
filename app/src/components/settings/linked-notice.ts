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

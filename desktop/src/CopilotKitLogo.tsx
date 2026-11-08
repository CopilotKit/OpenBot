/**
 * CopilotKit's logotype, on the screens that sign in to a CopilotKit account.
 *
 * OpenBot's mark heads every setup step, this one included, because OpenBot is what is being set
 * up. The account is CopilotKit's, though, so the sign-in shows whose account it is: the full
 * logotype, which is the brand's default, never the symbol alone. The reversed wordmark on dark, as
 * the brand sets it; the symbol keeps its colour.
 *
 * From `public/`, so it ships with the window and is never fetched.
 */
export function CopilotKitLogo() {
  return (
    <picture className="copilotkit-logo">
      <source
        srcSet="/copilotkit-logo-dark.svg"
        media="(prefers-color-scheme: dark)"
      />
      <img src="/copilotkit-logo.svg" alt="CopilotKit" />
    </picture>
  );
}

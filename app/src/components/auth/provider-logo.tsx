import type { AuthProviderId } from "@/lib/auth/queries";

/**
 * The mark each identity provider requires on a sign-in button.
 *
 * Drawn inline rather than fetched. These sit on the one screen somebody reaches before they have a
 * session, so a mark that arrives over the network is a mark that can be missing exactly when the
 * page has to be trustworthy, and a request to a third party from an unauthenticated page is a
 * request nobody asked for.
 *
 * Reproduced at their published colours because two of the three require it. Google's guidelines say
 * the standard colour G, at its own aspect ratio, neither recoloured nor restretched, and Microsoft
 * publish the four squares the same way. They are trade marks used to say "this button signs you in
 * with them", which is what the guidelines are for.
 *
 * All three are drawn into the same 18x18 box so the buttons line up. Google's G is not square, so
 * it is centred in the box rather than stretched to fill it.
 */
export function ProviderLogo({ provider }: { provider: AuthProviderId }) {
  if (provider === "google") return <GoogleMark />;
  if (provider === "microsoft") return <MicrosoftMark />;
  return <OktaMark />;
}

/** Google's four-colour G, at the published path and colours. */
function GoogleMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-[18px]"
      focusable="false"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
        fill="#4285F4"
      />
      <path
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
        fill="#34A853"
      />
      <path
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
        fill="#FBBC05"
      />
      <path
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
        fill="#EA4335"
      />
    </svg>
  );
}

/** Microsoft's four squares, at their published colours. */
function MicrosoftMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-[18px]"
      focusable="false"
      viewBox="0 0 23 23"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M1 1h10v10H1z" fill="#F25022" />
      <path d="M12 1h10v10H12z" fill="#7FBA00" />
      <path d="M1 12h10v10H1z" fill="#00A4EF" />
      <path d="M12 12h10v10H12z" fill="#FFB900" />
    </svg>
  );
}

/**
 * Okta's circular mark.
 *
 * `currentColor` rather than Okta blue, which is the one difference between this and the other two.
 * Okta is not a consumer sign-in button somebody recognises by colour; it is whichever Okta the
 * company running this deployment happens to use, and their guidelines allow a monochrome mark. It
 * also means it stays legible in both themes without a second asset.
 */
function OktaMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-[18px]"
      focusable="false"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"
        fill="currentColor"
      />
    </svg>
  );
}

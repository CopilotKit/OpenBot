import { useId } from "react";
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

/**
 * CopilotKit's mark, at its published colours, for a hosted OpenBot's sign-in with a CopilotKit
 * account. Its gradients are named for this drawing alone, so two on a page never share one.
 */
export function CopilotKitMark() {
  // Letters and digits only: React's ids carry punctuation a `url(#…)` reference can trip on.
  const id = `ck${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      aria-hidden="true"
      className="size-[18px]"
      fill="none"
      focusable="false"
      viewBox="0 0 224.43 237.166"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M76.4556 75.7547C97.0552 48.81 114.152 22.1656 120.731 0.648813C120.908 0.0633572 121.594 -0.185355 122.103 0.152636C144.979 15.3013 186.646 25.2726 223.5 25.5066C224.134 25.5107 224.571 26.1359 224.342 26.7272C212.088 57.8146 197.122 113.518 196.54 177.128C196.54 178.073 195.21 178.412 194.742 177.59C173.768 140.886 106.586 89.3107 76.7986 77.138C76.2477 76.9114 76.0919 76.2307 76.4556 75.7547Z"
        fill={`url(#${id}-paint0)`}
      />
      <path
        d="M145.956 59.273C113.757 69.4674 84.3336 75.1349 77.3077 76.4226C76.8608 76.5047 76.7673 77.1231 77.1934 77.2977C107.209 89.777 174.059 141.202 194.835 177.757C194.877 177.837 194.981 177.867 195.064 177.83C195.147 177.791 195.189 177.687 195.158 177.597L145.956 59.273Z"
        fill={`url(#${id}-paint1)`}
      />
      <path
        d="M122.197 0.0860308C149.76 15.1211 181.615 21.8738 223.875 25.4319C224.135 25.4546 224.228 25.8103 223.989 25.9339C218.585 28.7116 187.623 44.4667 164.633 52.905C158.47 55.1657 152.275 57.263 146.174 59.1979C146.039 59.2402 145.894 59.1736 145.842 59.0446L121.563 0.655481C121.397 0.262302 121.823 -0.117886 122.197 0.0860308Z"
        fill={`url(#${id}-paint2)`}
      />
      <path
        d="M121.361 0.145972C121.761 -0.0218955 122.214 0.121754 122.45 0.467128L122.536 0.6264L196.496 177.058L196.548 177.233C196.628 177.642 196.415 178.065 196.015 178.233C195.615 178.401 195.162 178.257 194.926 177.912L194.838 177.753L120.881 1.32093L120.826 1.14599C120.745 0.736568 120.961 0.313703 121.361 0.145972Z"
        fill="#513C9F"
      />
      <path
        d="M223.089 25.5869C223.52 25.3424 224.069 25.4925 224.313 25.9238C224.558 26.3552 224.406 26.9035 223.974 27.1483V27.1509H223.969C223.965 27.153 223.96 27.1575 223.953 27.1614C223.939 27.1695 223.916 27.1821 223.888 27.1979C223.832 27.2294 223.749 27.2755 223.64 27.3363C223.419 27.4593 223.091 27.6413 222.661 27.8768C221.8 28.3482 220.529 29.0371 218.885 29.9029C215.597 31.6348 210.813 34.0821 204.83 36.9423C192.865 42.6619 176.091 50.0388 156.86 56.6737C137.624 63.3089 117.782 68.4614 102.755 71.9534C95.2398 73.6998 88.9245 75.0317 84.4882 75.9274C82.2701 76.3752 80.5211 76.7135 79.3262 76.9405C78.7293 77.0538 78.2706 77.1391 77.9606 77.1963C77.8058 77.2249 77.6873 77.2472 77.6081 77.2616C77.5693 77.2687 77.5395 77.2737 77.5194 77.2773C77.5095 77.2791 77.501 77.2816 77.4959 77.2825H77.488L77.3052 77.2982C76.8881 77.2877 76.5205 76.9859 76.4436 76.5593C76.356 76.0711 76.6815 75.6027 77.1695 75.5149H77.1773C77.182 75.514 77.1888 75.5113 77.1982 75.5096C77.2176 75.5061 77.2481 75.501 77.287 75.494C77.3647 75.4798 77.4812 75.4595 77.6342 75.4313C77.9413 75.3746 78.3978 75.2882 78.992 75.1754C80.1806 74.9497 81.9227 74.6138 84.1331 74.1676C88.5551 73.2748 94.8521 71.9459 102.348 70.204C117.342 66.7197 137.119 61.5841 156.276 54.9766C175.426 48.3694 192.134 41.0193 204.055 35.3208C210.015 32.4718 214.777 30.0352 218.047 28.3128C219.682 27.4518 220.944 26.7694 221.796 26.3024C222.222 26.0693 222.546 25.8906 222.763 25.7697C222.871 25.7092 222.954 25.6619 223.008 25.6313C223.035 25.6163 223.055 25.6049 223.068 25.5974C223.075 25.5937 223.08 25.5914 223.084 25.5895L223.086 25.5869H223.089Z"
        fill="#513C9F"
      />
      <path
        d="M2.77027 236.611C2.20838 237.273 1.21525 237.353 0.553517 236.792C-0.107154 236.23 -0.18789 235.239 0.373357 234.577L2.77027 236.611ZM132.306 21.7584C133.136 22.0085 133.607 22.8858 133.358 23.7167L106.569 112.86H169.57L169.886 112.891C170.602 113.037 171.142 113.672 171.142 114.431C171.142 115.191 170.602 115.825 169.886 115.972L169.57 116.003H105.182L2.77027 236.611L1.57181 235.593L0.373357 234.577L103.044 113.664L130.347 22.8133C130.597 21.9819 131.474 21.5086 132.306 21.7584Z"
        fill="#ABABAB"
      />
      <path
        d="M72.9636 210.65L60.8346 212.356C67.1226 228.985 80.0206 236.249 95.4131 236.249C133.141 236.249 121.625 193.585 143.482 193.585C159.342 193.585 152.899 228.165 187.02 228.165C207.848 228.165 209.927 207.183 206.372 198.156C206.351 198.101 206.331 198.051 206.299 198.002L200.718 189.455C200.355 188.887 199.471 189.101 199.409 189.776L198.369 200.135C198.297 200.856 198.317 201.574 198.401 202.293C199.253 209.45 199.804 226.818 187.02 226.818C173.54 226.818 170.297 192.686 143.482 192.686C112.032 192.686 116.075 234.902 96.7643 234.902C84.0221 234.902 74.3043 220.531 72.9636 210.65Z"
        fill={`url(#${id}-paint3)`}
      />
      <defs>
        <linearGradient
          id={`${id}-paint0`}
          x1="171.825"
          y1="13.8344"
          x2="135.895"
          y2="112.635"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#6430AB" />
          <stop offset="1" stopColor="#AA89D8" />
        </linearGradient>
        <linearGradient
          id={`${id}-paint1`}
          x1="143.981"
          y1="69.5214"
          x2="97.7306"
          y2="158.891"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#005DBB" />
          <stop offset="1" stopColor="#3D92E8" />
        </linearGradient>
        <linearGradient
          id={`${id}-paint2`}
          x1="164.633"
          y1="13.8337"
          x2="150.706"
          y2="57.3959"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#1B70C4" />
          <stop offset="1" stopColor="#54A4F2" />
        </linearGradient>
        <linearGradient
          id={`${id}-paint3`}
          x1="60.8346"
          y1="213.57"
          x2="207.775"
          y2="213.57"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#4497EA" />
          <stop offset="0.254755" stopColor="#1463B2" />
          <stop offset="0.498725" stopColor="#0A437D" />
          <stop offset="0.666667" stopColor="#2476C8" />
          <stop offset="0.972542" stopColor="#0C549A" />
        </linearGradient>
      </defs>
    </svg>
  );
}

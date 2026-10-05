import type { SVGProps } from "react";

/**
 * Decorative waiting artwork for the fixed-size computer frame.
 */
export function ComputerPlaceholder(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 1200 800"
      preserveAspectRatio="xMidYMin slice"
      fill="none"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g clipPath="url(#clip0_2002_10)">
        <path fill="#fff" d="M0 0H1200V800H0z" />
        <path fill="url(#paint0_linear_2002_10)" d="M0 0H1200V754H0z" />
        <g
          opacity={0.93}
          filter="url(#filter0_n_2002_10)"
          style={{
            mixBlendMode: "lighten",
          }}
        >
          <path
            transform="rotate(180 1201 754)"
            fill="url(#paint1_radial_2002_10)"
            d="M1201 754H2402V1509H1201z"
          />
        </g>
        <g
          filter="url(#filter1_n_2002_10)"
          style={{
            mixBlendMode: "color-burn",
          }}
        >
          <path fill="#F0F0F0" fillOpacity={0.84} d="M0 0H1200V754H0z" />
        </g>
      </g>
      <defs>
        <filter
          id="filter0_n_2002_10"
          x={0}
          y={-1}
          width={1201}
          height={755}
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity={0} result="BackgroundImageFix" />
          <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.76923078298568726 0.76923078298568726"
            stitchTiles="stitch"
            numOctaves={3}
            result="noise"
            seed={2673}
          />
          <feComponentTransfer in="noise" result="coloredNoise1">
            <feFuncR type="linear" slope={2} intercept={-0.5} />
            <feFuncG type="linear" slope={2} intercept={-0.5} />
            <feFuncB type="linear" slope={2} intercept={-0.5} />
            <feFuncA
              type="discrete"
              tableValues="1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"
            />
          </feComponentTransfer>
          <feComposite
            operator="in"
            in2="shape"
            in="coloredNoise1"
            result="noise1Clipped"
          />
          <feComponentTransfer in="noise1Clipped" result="color1">
            <feFuncA type="table" tableValues="0 0.15" />
          </feComponentTransfer>
          <feMerge result="effect1_noise_2002_10">
            <feMergeNode in="shape" />
            <feMergeNode in="color1" />
          </feMerge>
        </filter>
        <filter
          id="filter1_n_2002_10"
          x={0}
          y={0}
          width={1200}
          height={754}
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity={0} result="BackgroundImageFix" />
          <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feTurbulence
            type="fractalNoise"
            baseFrequency="2 2"
            stitchTiles="stitch"
            numOctaves={3}
            result="noise"
            seed={7521}
          />
          <feColorMatrix
            in="noise"
            type="luminanceToAlpha"
            result="alphaNoise"
          />
          <feComponentTransfer in="alphaNoise" result="coloredNoise1">
            <feFuncA
              type="discrete"
              tableValues="1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"
            />
          </feComponentTransfer>
          <feComposite
            operator="in"
            in2="shape"
            in="coloredNoise1"
            result="noise1Clipped"
          />
          <feFlood floodColor="rgba(0, 0, 0, 0.25)" result="color1Flood" />
          <feComposite
            operator="in"
            in2="noise1Clipped"
            in="color1Flood"
            result="color1"
          />
          <feMerge result="effect1_noise_2002_10">
            <feMergeNode in="shape" />
            <feMergeNode in="color1" />
          </feMerge>
        </filter>
        <linearGradient
          id="paint0_linear_2002_10"
          x1={1200}
          y1={-53.8571}
          x2={-274.518}
          y2={423.589}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFB8E7" />
          <stop offset={1} stopColor="#2EE297" />
        </linearGradient>
        <radialGradient
          id="paint1_radial_2002_10"
          cx={0}
          cy={0}
          r={1}
          gradientTransform="matrix(229.838 -1654.36 2337.29 481.415 2278.37 2408.36)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset={0.420388} stopColor="#9DF200" />
          <stop offset={0.66} stopColor="#0099A9" />
          <stop offset={1} stopColor="#fff" />
        </radialGradient>
        <clipPath id="clip0_2002_10">
          <path fill="#fff" d="M0 0H1200V800H0z" />
        </clipPath>
      </defs>
    </svg>
  );
}

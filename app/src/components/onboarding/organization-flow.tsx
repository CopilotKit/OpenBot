import {
  IconBrandGoogle,
  IconBrandWindows,
  IconKey,
  IconListCheck,
  IconRobot,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useReducedMotion } from "motion/react";
import AgentOrb from "@/components/agents/orb/agent-orb";

/*
 * Drawn on one fixed grid so the connectors and the pills always meet: the SVG and the pills share
 * the same coordinate box, and each pill is centred on the point its line ends at.
 */
const WIDTH = 360;
const HEIGHT = 210;
const HUB = { x: WIDTH / 2, y: HEIGHT / 2 };
const COLUMNS = [60, WIDTH / 2, WIDTH - 60];
const TOP_Y = 18;
const BOTTOM_Y = HEIGHT - 18;

type Node = {
  label: string;
  icon: typeof IconKey;
  /** Tailwind classes for the small square behind the icon. */
  tone: string;
};

/** Who signs in: the identity providers the slide's sentence names. Okta has no glyph, so a key. */
const SIGN_IN: Node[] = [
  {
    label: "Google",
    icon: IconBrandGoogle,
    tone: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  },
  {
    label: "Microsoft",
    icon: IconBrandWindows,
    tone: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  },
  {
    label: "Okta",
    icon: IconKey,
    tone: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
  },
];

/** What an organization gets once its people are in. */
const OUTCOMES: Node[] = [
  {
    label: "Your rules",
    icon: IconShieldCheck,
    tone: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  {
    label: "Team Bots",
    icon: IconRobot,
    tone: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  {
    label: "Audit trail",
    icon: IconListCheck,
    tone: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
];

/** A gentle S-curve from a pill into the hub's top edge, or out of its bottom edge. */
function inbound(x: number) {
  return `M ${x} ${TOP_Y + 12} C ${x} ${TOP_Y + 52}, ${HUB.x} ${HUB.y - 62}, ${HUB.x} ${HUB.y - 22}`;
}
function outbound(x: number) {
  return `M ${HUB.x} ${HUB.y + 22} C ${HUB.x} ${HUB.y + 62}, ${x} ${BOTTOM_Y - 52}, ${x} ${BOTTOM_Y - 12}`;
}

function Pill({ node, x, y }: { node: Node; x: number; y: number }) {
  const Icon = node.icon;
  return (
    <div
      className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card py-1 pr-2.5 pl-1 text-xs shadow-xs"
      style={{ left: x, top: y }}
    >
      <span
        className={`flex size-5 items-center justify-center rounded-full ${node.tone}`}
      >
        <Icon aria-hidden className="size-3" stroke={2} />
      </span>
      {node.label}
    </div>
  );
}

/**
 * How OpenBot sits inside an organization: its people sign in through the organization's own
 * identity provider, and what comes out is its own rules, its own Bots and a record of every action.
 *
 * Built here from Tailwind and SVG, in the visual language of node-and-connector diagrams, rather
 * than copied from a commercial illustration set. A dot runs each connector into and out of the hub;
 * somebody who asks for reduced motion gets the diagram still.
 */
export function OrganizationFlow() {
  const reduceMotion = useReducedMotion();
  const paths = [...COLUMNS.map(inbound), ...COLUMNS.map(outbound)];
  return (
    <div className="relative mx-auto" style={{ width: WIDTH, height: HEIGHT }}>
      <svg
        aria-hidden
        className="absolute inset-0 text-border"
        fill="none"
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width={WIDTH}
      >
        {paths.map((d) => (
          <path d={d} key={d} stroke="currentColor" strokeWidth={1.25} />
        ))}
        {reduceMotion
          ? null
          : paths.map((d, index) => (
              <circle
                className="fill-muted-foreground/60"
                key={`dot-${d}`}
                r={2}
              >
                {/* Inbound dots first, outbound after, so the flow reads top to bottom. */}
                <animateMotion
                  begin={`${(index % 3) * 0.4 + (index < 3 ? 0 : 1.2)}s`}
                  dur="2.4s"
                  path={d}
                  repeatCount="indefinite"
                />
              </circle>
            ))}
      </svg>

      {SIGN_IN.map((node, index) => (
        <Pill key={node.label} node={node} x={COLUMNS[index] ?? 0} y={TOP_Y} />
      ))}

      <div
        className="absolute flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card shadow-xs"
        style={{ left: HUB.x, top: HUB.y }}
      >
        <AgentOrb size="28px" />
      </div>

      {OUTCOMES.map((node, index) => (
        <Pill
          key={node.label}
          node={node}
          x={COLUMNS[index] ?? 0}
          y={BOTTOM_Y}
        />
      ))}
    </div>
  );
}

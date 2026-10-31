import { WEB_HARNESSES } from "@openbot/shared/harnesses";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { HarnessMark } from "@/components/agents/harness-mark";
import { appConfig } from "@/lib/generated/application-config";
import { LaptopIllustration } from "../laptop-illustration";
import { OrganizationFlow } from "../organization-flow";
import { DemoStage } from "../demo-stage";

/** Every framework the New Bot wizard offers by name; "an agent you already run" is the sentence. */
export const FRAMEWORKS = WEB_HARNESSES.filter(
  (harness) => harness.id !== "byo-url",
);

const PRODUCT = appConfig.brand.productName;

/** The three things somebody running OpenBot themselves is deciding, one picture each. */
const PANELS: Array<{ id: string; caption: string; picture: () => ReactNode }> =
  [
    {
      id: "local",
      caption: "On this computer",
      picture: () => <LaptopIllustration />,
    },
    {
      id: "agents",
      caption: "With the agents you already have",
      picture: () => (
        <div className="flex flex-wrap justify-center gap-2">
          {FRAMEWORKS.map((harness) => (
            <span
              className="type-caption flex items-center gap-2 rounded-full bg-card px-3 py-1.5 shadow-(--shadow-card)"
              key={harness.id}
            >
              <HarnessMark id={harness.mark} name={harness.name} />
              {harness.name}
            </span>
          ))}
        </div>
      ),
    },
    {
      id: "organization",
      caption: "For your organization",
      picture: () => <OrganizationFlow />,
    },
  ];

function Panel({ panel }: { panel: (typeof PANELS)[number] }) {
  return (
    <div className="flex flex-col items-center gap-5" data-panel={panel.id}>
      <p className="type-caption font-medium text-muted-foreground">
        {panel.caption}
      </p>
      {panel.picture()}
    </div>
  );
}

/**
 * Running it yourself: on this computer, with the agents you already have, and for your
 * organization. The three local-evaluation slides as one picture that turns through them.
 * With reduced motion the three sit one above the other.
 */
export function SelfHostDemo() {
  return (
    <DemoStage
      beats={PANELS.length}
      beatMs={3200}
      className="flex min-h-[22rem] flex-col justify-center gap-10 px-4 py-8 sm:px-6"
      kind="self-host"
      label={`${PRODUCT} on a laptop; frameworks that work as Bots: ${FRAMEWORKS.map((harness) => harness.name).join(", ")}; and your organization signing in with Google, Microsoft or Okta`}
      rest={-1}
    >
      {({ beat, reduced }) =>
        reduced ? (
          PANELS.map((panel) => <Panel key={panel.id} panel={panel} />)
        ) : (
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              initial={{ opacity: 0, y: 8 }}
              key={PANELS[beat]?.id}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              {PANELS[beat] ? <Panel panel={PANELS[beat]} /> : null}
            </motion.div>
          </AnimatePresence>
        )
      }
    </DemoStage>
  );
}

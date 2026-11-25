import { EmptyState, Screen } from "../../../src/components";
import { IconPlug } from "../../../src/icons";

/**
 * Connections: the apps and accounts every Bot uses as you. The phone shows where they are made
 * for now; connecting one happens in OpenBot on your computer.
 */
export default function Connections() {
  return (
    <Screen className="justify-center">
      <EmptyState
        icon={IconPlug}
        title="Connect your accounts on your computer"
        description="Open Connections in OpenBot on your computer to connect the apps your Bots use. They work here once they're connected."
      />
    </Screen>
  );
}

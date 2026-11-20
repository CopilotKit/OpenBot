import {
  RECORDER_COLLECTS,
  type RecorderCollectedKind,
} from "@openbot/shared/recorder-disclosure";
import {
  IconDeviceFloppy,
  IconEyeOff,
  IconMessageChatbot,
  IconMicrophone,
  IconPointer,
  IconShieldLock,
} from "@tabler/icons-react";
import { Fragment } from "react";
import { PageRows } from "@/components/layout/page-parts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";

const ICONS: Record<RecorderCollectedKind, typeof IconPointer> = {
  steps: IconPointer,
  saves: IconDeviceFloppy,
  assistants: IconMessageChatbot,
  narration: IconMicrophone,
  masking: IconShieldLock,
  sites: IconEyeOff,
};

/**
 * What a recording holds, one read-only row each (@openbot/shared/recorder-disclosure). Drawn by OpenBot's Settings,
 * Browsers before the first Connect and by the Recorder's own setup page (the extension builds with this app's
 * components), so the person reads the same list in both before anything is collected.
 */
export function RecorderCollectsRows() {
  return (
    <PageRows>
      {RECORDER_COLLECTS.map(({ kind, title, description }, index) => {
        const Icon = ICONS[kind];
        return (
          <Fragment key={kind}>
            {index > 0 ? <Separator /> : null}
            <Item size="sm">
              <ItemMedia variant="icon">
                <Icon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{title}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {description}
                </ItemDescription>
              </ItemContent>
            </Item>
          </Fragment>
        );
      })}
    </PageRows>
  );
}

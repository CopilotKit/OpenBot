import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import {
  type GenerativeUIErrorInfo,
  GenerativeUISurface,
  useGenerativeUIRuntime,
} from "@copilotkit/react-core/v2/generative-ui";
import { standardUiFamily } from "@openbot/shared/standard-ui";
import { useEffect } from "react";
import { OPENBOT_UI, OPENBOT_UI_THEME } from "@/lib/copilot/a2ui";
import { BUILDING_BLOCK_SAMPLES } from "./building-block-samples";

const THREAD = "building-block-preview";
const TARGET = "preview";

/** Commits the sample as the runtime would commit a Bot's render_ui call. */
function Sample({ head }: { head: string }) {
  const runtime = useGenerativeUIRuntime();
  useEffect(() => {
    const sample = BUILDING_BLOCK_SAMPLES[head];
    if (!runtime || !sample) return;
    runtime.manager.setActiveThread(THREAD);
    runtime.manager.ingest(THREAD, undefined, {
      surfaceId: head,
      target: TARGET,
      catalogId: OPENBOT_UI.id,
      status: "ready",
      rejected: [],
      operations: [
        {
          version: "v1.0",
          createSurface: {
            surfaceId: head,
            catalogId: OPENBOT_UI.id,
            ...(sample.dataModel ? { dataModel: sample.dataModel } : {}),
          },
        },
        {
          version: "v1.0",
          updateComponents: { surfaceId: head, components: sample.components },
        },
      ],
    });
  }, [runtime, head]);
  return null;
}

/**
 * A family of the standard catalog, drawn by the SDK from its sample.
 *
 * In a provider of its own, with no runtime: the preview is a surface on a thread nobody talks on,
 * so it can neither reach a conversation nor be mistaken for one.
 */
export function BuildingBlockPreview({
  name,
  onError,
}: {
  name: string;
  /** For tests: every operation, prop or render failure of the sample. */
  onError?: (info: GenerativeUIErrorInfo) => void;
}) {
  const family = standardUiFamily(name);
  if (!family || !BUILDING_BLOCK_SAMPLES[family.head]) return null;
  return (
    <CopilotKitProvider
      enableInspector={false}
      generativeUI={{
        ui: OPENBOT_UI,
        theme: OPENBOT_UI_THEME,
        ...(onError ? { errorBoundary: { onError } } : {}),
      }}
    >
      <Sample head={family.head} />
      <GenerativeUISurface autoScroll={false} id={TARGET} />
    </CopilotKitProvider>
  );
}

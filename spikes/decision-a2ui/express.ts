import type {
  A2uiRequestProcessor,
  RendererState,
  ResponsePart,
} from "@a2ui/agent";
import { surfaceId } from "./sdk.ts";
import type { AgentToRendererMessage } from "@a2ui/web_core/v1_0";

export function expressPrompt(processor: A2uiRequestProcessor) {
  return `Build UI using only the supplied application data. Return an Express block for surface "spike".
Use stable component IDs: title, settings_group, name, notify, results_group, detail, detail_frame,
result_<application ID>, confirm_frame, confirm_group and confirm as appropriate.
For a result button, use action={event:{name:"choose_result", context:{id:"birch"}}} for Birch and substitute the other IDs for the other results.
For an independently scrollable result collection use List. For a framed group use Card with a single child.
Bind the detail text to /detail. In a follow-up turn target the existing surface with update=true
and change only /selectedId and /detail. Use a short plain-text answer when the requested screen
cannot be built using the supplied app data or when clarification is required.
${processor.promptSnippet}`;
}

export async function collectExpress(
  processor: A2uiRequestProcessor,
  state: RendererState,
  chunks: AsyncIterable<string>,
  now = () => performance.now(),
) {
  const stream = processor.openStream({ state });
  const messages: AgentToRendererMessage[] = [];
  let text = "";
  let firstRenderableMs: number | null = null;
  const start = now();
  const existing = state.getSurface(surfaceId) !== undefined;
  // The stream's state may already contain messages from later parts of a
  // single feed(). A second mirror tests exactly the prefix we would deliver.
  const prefix = existing ? undefined : processor.createState();

  function collect(parts: ResponsePart[]) {
    for (const part of parts) {
      if (part.type === "text") {
        text += part.text;
        continue;
      }
      for (const message of part.a2ui) {
        if (message.version !== "1.0") throw new Error("Expected A2UI v1.0");
        messages.push(message);
        if (firstRenderableMs !== null) continue;
        prefix?.apply(message);
        if (existing) {
          if (
            "updateDataModel" in message &&
            message.updateDataModel.surfaceId === surfaceId
          ) {
            firstRenderableMs = now() - start;
          }
          continue;
        }
        if (!prefix?.getSurface(surfaceId)?.componentsModel.get("root"))
          continue;
        try {
          prefix.checkTopology([surfaceId]);
          firstRenderableMs = now() - start;
        } catch {
          // Progressive Express can send a root before every child arrives.
        }
      }
    }
  }
  for await (const chunk of chunks) collect(stream.feed(chunk));
  collect(stream.close());
  return { messages, text, firstRenderableMs };
}

// Handwritten recorded-shape fixtures. Live Express gets the same requests
// and app data as the decision system without using these strings.
const replay = {
  settings: `surface("spike")
$/name = "Ada"
$/notify = true
root = Column([title, settingsGroup])
title = Text("Settings")
settingsGroup = Column([name, notify], id="settings_group")
name = TextField("Display name", $/name)
notify = CheckBox("Email updates", $/notify)`,
  results: `surface("spike")
$/detail = "Select a result to see its details."
root = Column([title, resultsGroup, detailFrame])
title = Text("Search results")
resultsGroup = List([alder, birch, cedar], id="results_group")
alder = Button(Text("Alder"), action={event:{name:"choose_result", context:{id:"alder"}}}, id="result_alder")
birch = Button(Text("Birch"), action={event:{name:"choose_result", context:{id:"birch"}}}, id="result_birch")
cedar = Button(Text("Cedar"), action={event:{name:"choose_result", context:{id:"cedar"}}}, id="result_cedar")
detailFrame = Card(detail, id="detail_frame")
detail = Text($/detail)`,
  confirmation: `surface("spike")
$/detail = "Reserve one place in Birch."
root = Column([confirmFrame])
confirmFrame = Card(confirmGroup, id="confirm_frame")
confirmGroup = Column([title, detail, confirm], id="confirm_group")
title = Text("Confirm booking")
detail = Text($/detail)
confirm = Button(Text("Confirm"), variant="primary", action={event:{name:"confirm_request"}})`,
  follow: `surface("spike", update=true)
$/selectedId = "birch"
$/detail = "Birch — available"`,
};

export async function* expressFixture(family: keyof typeof replay) {
  const text = `<a2ui>\n${replay[family]}\n</a2ui>`;
  for (let offset = 0; offset < text.length; offset += 37)
    yield text.slice(offset, offset + 37);
}

"""Each run answers from the thread the server sent, and from nothing this process remembers.

The server restores the whole thread from Intelligence and sends it on every run, behind the Bot's
standing role and its granted-tools summary as system messages (`runWith` in
`server/src/copilot.ts`). `ag-ui-langgraph` 0.0.45 is built for the opposite arrangement, where the
checkpoint is the conversation and a request only adds to it, and two of its choices broke that:

- `langgraph_default_merge_state` drops `messages[0]` when it is a system message. That is always
  the standing role, so the model never saw it, cold or warm; for a remote Bot it is the only way
  the role arrives.
- The merge keeps the checkpoint and adds only incoming messages whose ids it has not stored. A
  message the server changed under the same id, such as `granted-tools:<bot>` after a grant
  changed, kept its old content for as long as the process lived, and an answer the server stored
  under its own id was in the context twice. After a restart the same thread read differently.

THE FIX IS A CHECKPOINTER PER RUN, not a different merge. The integration reads the checkpoint
for more than messages (regenerate and edit detection, interrupts, `tools` and `ag-ui` state), and
every one of those comparisons is between the request and what an earlier run left; starting each
run from an empty checkpoint makes all of them agree with the request at once, and the merge then
takes the whole request in order. A fresh `MemorySaver` per run also means nothing grows per
thread: the one `main.py` compiled with was never evicted.

The checkpointer is still needed inside a run: the integration reads the final state from it, and
a tool turn loops `answer` -> `tools` -> `answer` through it. Nothing in this graph calls
`interrupt()`, so no run is ever resumed from a later request; a surface tool ends the run, and the
next request brings the call and its result back in `messages` like the rest of the thread.
"""

from contextlib import aclosing

from langchain_core.messages import SystemMessage
from langgraph.checkpoint.memory import MemorySaver

from .parallel_tools import ParallelToolAgent


class WholeThreadAgent(ParallelToolAgent):
    async def run(self, input):
        # The endpoint clones the agent per request, so this swaps the clone's graph; the restore
        # keeps an agent that is run directly from carrying one run's checkpoint into the next.
        shared = self.graph
        self.graph = shared.copy(update={"checkpointer": MemorySaver()})
        try:
            async with aclosing(super().run(input)) as stream:
                async for event in stream:
                    yield event
        finally:
            self.graph = shared

    def langgraph_default_merge_state(self, state, messages, input):
        merged = super().langgraph_default_merge_state(state, messages, input)
        if messages and isinstance(messages[0], SystemMessage):
            # Upstream drops it unconditionally. With an empty checkpoint nothing else can have
            # put it there, so it goes back at the front, where the server placed it.
            merged["messages"] = [messages[0], *merged["messages"]]
        return merged

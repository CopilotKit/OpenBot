"""Compatibility boundary for ag-ui-langgraph 0.0.45's single tool stream slot.

Upstream #1016 handles only the first indexed chunk and conflates interleaved
arguments. Keep its emitter, ID mapping, snapshots and lifecycle; give each
model call/index its own upstream slot. Remove this shim when an upstream
release passes the protocol/client regressions, then deliberately update the pin.
"""

from contextlib import aclosing

from ag_ui.core import EventType, RunErrorEvent
from ag_ui_langgraph import LangGraphAgent


class ToolStreamError(ValueError):
    pass


def _get(value, key, default=None):
    return (
        value.get(key, default)
        if isinstance(value, dict)
        else getattr(value, key, default)
    )


def _chunk_event(event, *, chunks, content=None):
    chunk = event["data"]["chunk"]
    update = {"tool_call_chunks": chunks, "content": content}
    if chunks:
        # This is only the tool portion of an event. Text, reasoning, usage
        # and finish metadata were already delivered once above.
        update.update(additional_kwargs={}, response_metadata={}, usage_metadata=None)
    clean = (
        {**chunk, **update}
        if isinstance(chunk, dict)
        else chunk.model_copy(update=update)
    )
    return {**event, "data": {**event["data"], "chunk": clean}}


class ParallelToolAgent(LangGraphAgent):
    async def run(self, input):
        # The maintained endpoint clones agents per request. Also reset here
        # for explicit reuse and when an HTTP consumer cancels/closes its run.
        streams = {}
        self._tool_streams = streams
        self._upstream_stream = None
        self._graph_stream = None
        try:
            async with aclosing(super().run(input)) as stream:
                async for event in stream:
                    yield event
        except ToolStreamError:
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message="The model returned an unidentifiable tool-call fragment.",
            )
        finally:
            try:
                if self._upstream_stream is not None:
                    await self._upstream_stream.aclose()
            finally:
                try:
                    if self._graph_stream is not None:
                        await self._graph_stream.aclose()
                finally:
                    streams.clear()

    def _handle_stream_events(self, input):
        # Upstream run uses a bare async-for. Keep its generator so closing
        # this wrapper also completes upstream's finally before a later run.
        self._upstream_stream = super()._handle_stream_events(input)
        return self._upstream_stream

    async def prepare_stream(self, input, agent_state, config):
        prepared = await super().prepare_stream(input, agent_state, config)
        self._graph_stream = prepared.get("stream")
        return prepared

    async def _handle_single_event(self, event, state):
        active_run = self.active_run
        kind = event.get("event")
        model_key = (self._current_lane(), event.get("run_id"))
        if kind == "on_chat_model_end":
            saved = self.get_message_in_progress(self.active_run["id"])
            try:
                for slot in self._tool_streams.pop(model_key, {}).values():
                    self.set_message_in_progress(self.active_run["id"], slot)
                    async for result in super()._handle_single_event(event, state):
                        yield result
            finally:
                self._restore_slot(saved, active_run)
            # Upstream still owns text closure and token usage (deduped by
            # model run), including model turns that contain no tools.
            async for result in super()._handle_single_event(event, state):
                yield result
            return

        chunk = event.get("data", {}).get("chunk")
        chunks = _get(chunk, "tool_call_chunks", []) or []
        if (
            kind != "on_chat_model_stream"
            or not chunks
            or (event.get("metadata") or {}).get("emit-tool-calls") is False
        ):
            async for result in super()._handle_single_event(event, state):
                yield result
            return

        # Deliver text/reasoning/usage exactly once through the same handler.
        async for result in super()._handle_single_event(
            _chunk_event(event, chunks=[], content=_get(chunk, "content")), state
        ):
            yield result

        slots = self._tool_streams.setdefault(model_key, {})
        for fragment in chunks:
            index = fragment.get("index")
            identity = (
                ("index", index) if index is not None else ("id", fragment.get("id"))
            )
            if identity[1] is None:
                raise ToolStreamError()
            previous = slots.get(identity)
            if previous is None and not (fragment.get("id") and fragment.get("name")):
                raise ToolStreamError()
            if (
                previous is not None
                and fragment.get("id")
                and self._resolve_public_tool_call_id(fragment["id"])
                != previous["tool_call_id"]
            ):
                raise ToolStreamError()
            saved = self.get_message_in_progress(self.active_run["id"])
            try:
                self._restore_slot(previous, active_run)
                if previous is None:
                    # Upstream returns immediately after START, dropping any
                    # args in that same fragment. Feed those separately below.
                    head = {**fragment, "args": ""}
                    async for result in super()._handle_single_event(
                        _chunk_event(event, chunks=[head]), state
                    ):
                        yield result
                if fragment.get("args"):
                    tail = {**fragment, "id": None, "name": None}
                    async for result in super()._handle_single_event(
                        _chunk_event(event, chunks=[tail]), state
                    ):
                        yield result
                slot = self.get_message_in_progress(self.active_run["id"])
                if slot is not None:
                    slots[identity] = slot
            finally:
                self._restore_slot(saved, active_run)

    def _restore_slot(self, slot, active_run):
        if self.active_run is not active_run or active_run is None:
            # An abandoned consumer can close the outer upstream run before
            # Python finalizes its nested event generator. Its run is gone.
            return
        if slot is None:
            self.clear_message_in_progress(self.active_run["id"])
        else:
            self.set_message_in_progress(self.active_run["id"], slot)

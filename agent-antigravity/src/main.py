"""Google Antigravity as a Bot, through `ag_ui_antigravity`, which AG-UI maintains.

GEMINI-ONLY, AND PINNED. Every other Bot in the box takes whatever provider the deployment chose:
they reach their model through LiteLLM or an equivalent, so `BOT_PROVIDER` moving them to Anthropic
or a compatible endpoint is a setting, not a break. Antigravity is not like that. Its SDK drives a
bundled Go `localharness`, and that harness wants a Gemini key wherever its base url points — the
integration's own README says so. So the provider is pinned here rather than read from the
environment, and the catalogue row says `credential: "google"` so the picker asks for the right key
instead of offering this row to a deployment that holds only an OpenAI one.

The model is still the deployment's to choose. `BOT_MODEL` names which Gemini; the pin only stops
the *provider* drifting to one the harness cannot use.

WHERE the Gemini lives is the deployment's too. The `google` row in `shared/model-providers.json`
names both variables this Bot reads — the key and the base url — and they are read from that row
rather than spelled out here, so renaming either is one edit to the file every language reads. A
base url set there sends the harness at a Gemini-compatible endpoint instead of Google's: a
gateway, a proxy that holds the real key, or a mock while someone tries the Bot out without one.
That url is the API ROOT, with no version path on it — `http://host:4141`, not
`http://host:4141/v1beta`. The harness appends `/v1beta/models/<model>:streamGenerateContent`
itself, and a url carrying the version already gets it twice and 404s, which the harness reports
as the unplaceable `agent executor error: Error 0, Message: Not found`. Measured against a logging
proxy, because that message names neither the url nor the status.

THE CONVERSATION is the server's, sent whole on every run. The integration keeps it in the harness
and forwards only the newest line, so `whole_thread.py` starts every harness session from the
thread the server sent, with its system messages as the instructions.
"""

import hmac
import os
import sys
from contextlib import aclosing
from contextvars import ContextVar
from functools import partial
from pathlib import Path
from a2ui.core import A2uiError

# The spec file every language in the box reads: one level above this Bot in the repository, and
# one level above /app/src in the image the Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import SPEC, bot_settings

from ag_ui_antigravity import create_antigravity_app
from fastapi import Request
from fastapi.responses import JSONResponse
from google.antigravity.models import GeminiAPIEndpoint
from google.antigravity.types import BuiltinTools, CapabilitiesConfig

from .express_canvas import (
    HYDROGEN_MODEL,
    CanvasVersions,
    canvas_tool,
    express_brief,
    gemini_text_chunks,
    stream_canvas,
)
from .express_catalog import CATALOG_PROP, catalog_from_offer
from .whole_thread import OpenBotAntigravityAgent, _text

TOKEN_HEADER = "x-openbot-agent-token"

#: The Gemini row this Bot is pinned to. Both variable names come from it.
_GOOGLE = SPEC["providers"]["google"]
_canvas_catalog: ContextVar = ContextVar("openbot_canvas_catalog", default=None)
_CANVAS_ROUTING = (
    "The canvas is the pane beside the chat. When the user asks for the canvas, call render_canvas "
    "to draw or edit it yourself. Inline widgets draw in chat. If you have the data you need, "
    "call render_canvas directly."
)
_HARNESS_WORKSPACE_TOOLS = frozenset({
    BuiltinTools.LIST_DIR,
    BuiltinTools.SEARCH_DIR,
    BuiltinTools.FIND_FILE,
    BuiltinTools.VIEW_FILE,
    BuiltinTools.CREATE_FILE,
    BuiltinTools.EDIT_FILE,
    BuiltinTools.RUN_COMMAND,
})


class CanvasAgent(OpenBotAntigravityAgent):
    def __init__(self, *, model, text_chunks, **kwargs):
        super().__init__(model=model, **kwargs)
        self._express_model = model
        self._text_chunks = text_chunks
        self._canvas_versions = CanvasVersions()

    def _draw(self, run, catalog, brief):
        props = run.forwarded_props
        model = (
            HYDROGEN_MODEL
            if isinstance(props, dict) and props.get("openbotExpressModel") == HYDROGEN_MODEL
            else self._express_model
        )
        metrics = {"model": model, "thinking": "low"}
        return stream_canvas(
            run, brief, partial(self._text_chunks, model=model, metrics=metrics), catalog=catalog,
            previous=self._canvas_versions.get(run.thread_id),
            remember=partial(self._canvas_versions.remember, run.thread_id),
            metrics=metrics,
        )

    async def run(self, input_data):
        offer = canvas_tool(input_data)
        props = input_data.forwarded_props
        manifest = props.get(CATALOG_PROP) if isinstance(props, dict) else None
        catalog = None
        if offer and isinstance(manifest, dict) and manifest.get("protocolVersion") == "1.0":
            try:
                catalog = catalog_from_offer(manifest)
            except (A2uiError, ValueError, KeyError, TypeError, AttributeError):
                pass
        brief = express_brief(input_data)
        if catalog is not None and brief is not None:
            events = self._draw(input_data, catalog, brief)
        elif catalog is not None:
            parameters = offer.parameters
            properties = parameters["properties"]
            target = properties["target"]
            remaining = [item for item in target["enum"] if item != "canvas"]
            tools = [tool for tool in input_data.tools if tool is not offer]
            if remaining:
                tools.append(offer.model_copy(update={
                    "description": "Render A2UI operations inline in the chat transcript.",
                    "parameters": {
                        **parameters,
                        "properties": {**properties, "target": {**target, "enum": remaining}},
                    },
                }))
            input_data = input_data.model_copy(update={
                "tools": tools,
                "context": [entry for entry in input_data.context if entry.description not in {
                    "Generative UI guide: available components, functions, targets, and how to call render_ui.",
                    "Design guidelines for the Personal Assistant's native canvas.",
                }],
            })
            events = self._run_with_canvas(input_data, catalog)
        else:
            events = super().run(input_data)
        async with aclosing(events):
            async for event in events:
                yield event

    async def _run_with_canvas(self, input_data, catalog):
        token = _canvas_catalog.set(catalog)
        try:
            async with aclosing(super().run(input_data)) as events:
                async for event in events:
                    yield event
        finally:
            _canvas_catalog.reset(token)

    async def _run_locked(self, session, input_data):
        bridge = session.bridge
        bridge.openbot_canvas_run = input_data
        bridge.openbot_canvas_catalog = _canvas_catalog.get()
        bridge.openbot_canvas_used = False
        async with aclosing(super()._run_locked(session, input_data)) as events:
            async for event in events:
                yield event

    def _build_agent(self, bridge, input_data, previous_conversation_id):
        if _canvas_catalog.get() is None:
            return super()._build_agent(bridge, input_data, previous_conversation_id)

        async def render_canvas(context: str = "") -> str:
            """Draw or edit the canvas in the pane beside chat. Pass any facts you looked up for the drawing in context."""
            run = bridge.openbot_canvas_run
            catalog = bridge.openbot_canvas_catalog
            if catalog is None:
                return "The canvas is unavailable for this run."
            if bridge.openbot_canvas_used:
                return "The canvas has already been requested in this run."
            bridge.openbot_canvas_used = True
            request = next(
                (_text(message.content) for message in reversed(run.messages) if message.role == "user"),
                "",
            )
            if not request and not context:
                return "The conversation has no canvas request."
            brief = f"{request}\n\nSupporting context\n{context}" if context else request
            # Retry an invalid first response only while no drawing has been
            # published. Both attempts use the same catalog and request.
            for _ in range(2):
                published = False
                failure = None
                async with aclosing(self._draw(run, catalog, brief)) as events:
                    async for event in events:
                        if event.type in ("ACTIVITY_SNAPSHOT", "ACTIVITY_DELTA"):
                            bridge.emit(event)
                            published = True
                        elif event.type == "RUN_ERROR":
                            failure = event.message
                if failure is None:
                    return "The canvas is ready."
                if published:
                    break
            return f"{failure} Report the failure to the user."

        tools = self._static_tools
        instructions = self._system_instructions
        original_capabilities = self._capabilities
        capabilities = original_capabilities or CapabilitiesConfig(
            enable_subagents=bool(self._subagents)
        )
        # The planner can use the tools OpenBot sent. Its own container is not
        # a source of conversation data or a place to implement the canvas.
        if capabilities.enabled_tools is not None:
            overrides = {"enabled_tools": [
                tool for tool in capabilities.enabled_tools if tool not in _HARNESS_WORKSPACE_TOOLS
            ]}
        else:
            overrides = {"disabled_tools": sorted(
                _HARNESS_WORKSPACE_TOOLS.union(capabilities.disabled_tools or ())
            )}
        self._static_tools = [*tools, render_canvas]
        self._capabilities = capabilities.model_copy(update=overrides)
        self._system_instructions = "\n\n".join(
            text for text in (instructions, _CANVAS_ROUTING) if text
        )
        try:
            return super()._build_agent(bridge, input_data, previous_conversation_id)
        finally:
            self._static_tools = tools
            self._capabilities = original_capabilities
            self._system_instructions = instructions


def _model() -> str:
    """Which Gemini this deployment wants.

    `pinned_provider` beats `BOT_PROVIDER`, which is the point: see the module docstring. The
    returned model is the bare name, not `provider/model` — Antigravity takes the Gemini model id
    directly rather than through a LiteLLM-style prefix.
    """
    return bot_settings("agent-antigravity", pinned_provider="google").model


def _api_key() -> str | None:
    """The key, under the name the provider row gives it.

    `GEMINI_API_KEY` is the SDK's own spelling and is taken as a second name for the same thing,
    because a deployment that already set it for another Google tool should not have to set it
    twice. Blank is not a choice: compose hands an unset variable through as an empty string.
    """
    for variable in (_GOOGLE["key_variable"], "GEMINI_API_KEY"):
        value = (os.environ.get(variable) or "").strip()
        if value:
            return value
    return None


def _agent() -> OpenBotAntigravityAgent:
    """The harness, pointed at whatever Gemini this deployment runs.

    With a base url the endpoint is spelled out: `AntigravityAgent(base_url=...)` is a DIFFERENT
    and mutually exclusive path, meant for unauthenticated local servers, and it drops the key.
    `endpoint=GeminiAPIEndpoint(...)` is the one that carries both — which is what a gateway, or a
    mock in front of the Gemini API, needs.
    """
    model, api_key = _model(), _api_key()
    base_url = (os.environ.get(_GOOGLE["base_url_variable"]) or "").strip()
    text_chunks = partial(
        gemini_text_chunks,
        api_key=api_key,
        base_url=base_url or "https://generativelanguage.googleapis.com",
    )
    if base_url:
        return CanvasAgent(
            text_chunks=text_chunks,
            model=model,
            endpoint=GeminiAPIEndpoint(base_url=base_url, api_key=api_key),
        )
    # Named rather than left to the SDK's own environment read, so a missing key is this Bot's
    # failure at start-up rather than a stream that opens and dies.
    return CanvasAgent(model=model, api_key=api_key, text_chunks=text_chunks)


app = create_antigravity_app(_agent(), path="/")


@app.middleware("http")
async def refuse_without_the_server_token(request: Request, call_next):
    if request.url.path != "/health":
        expected = (os.environ.get("MANAGED_AGENT_TOKEN") or "").strip()
        offered = (request.headers.get(TOKEN_HEADER) or "").strip()
        if not expected or not hmac.compare_digest(
            offered.encode("utf-8"), expected.encode("utf-8")
        ):
            return JSONResponse({"error": "unauthorised"}, status_code=401)
    return await call_next(request)


@app.get("/health")
async def health():
    return {"ok": True, "harness": "antigravity"}

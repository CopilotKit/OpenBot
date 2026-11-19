"""Stream a Canvas through Gemini and the A2UI Express compiler."""

import json
import logging
from collections import OrderedDict
from contextlib import aclosing
from uuid import NAMESPACE_URL, uuid5

import httpx
from a2ui.core import A2uiError
from a2ui.inference_formats import ExpressFormatFactory
from a2ui.parser import A2uiPart
from a2ui.parser.messages import to_message_dicts
from a2ui.processor import A2uiRequestProcessor
from ag_ui.core import (
    ActivityDeltaEvent,
    ActivitySnapshotEvent,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
)

ACTIVITY = "generative-ui-surface"
OPERATIONS = ("createSurface", "updateComponents", "updateDataModel")
HYDROGEN_MODEL = "gemini-4-hydrogen"
_logger = logging.getLogger("uvicorn.error")


class CanvasVersions:
    """Keep the most recent editable surface for each active trial thread."""

    def __init__(self):
        self._latest = OrderedDict()

    def get(self, thread_id):
        if thread_id in self._latest:
            self._latest.move_to_end(thread_id)
        return self._latest.get(thread_id)

    def remember(self, thread_id, surface):
        if len(json.dumps(surface)) > 128_000:
            self._latest.pop(thread_id, None)
            return
        self._latest[thread_id] = surface
        self._latest.move_to_end(thread_id)
        if len(self._latest) > 50:
            self._latest.popitem(last=False)


def express_brief(run):
    if not run.messages or run.messages[-1].role != "user":
        return None
    content = run.messages[-1].content
    if not isinstance(content, str):
        return None
    prefix, _, brief = content.strip().partition(":")
    if prefix.casefold() != "express" or not brief.strip():
        return None
    return brief.strip() if canvas_tool(run) is not None else None


def canvas_tool(run):
    for tool in run.tools:
        if tool.name != "render_ui":
            continue
        properties = tool.parameters.get("properties")
        target = properties.get("target") if isinstance(properties, dict) else None
        choices = target.get("enum") if isinstance(target, dict) else None
        if isinstance(choices, list) and "canvas" in choices:
            return tool
    return None


async def gemini_text_chunks(prompt, *, model, api_key, base_url, metrics=None):
    url = f"{base_url.rstrip('/')}/v1beta/models/{model}:streamGenerateContent"
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"thinkingConfig": {"thinkingLevel": "LOW"}},
    }
    headers = {"x-goog-api-key": api_key} if api_key else {}
    async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=10)) as client:
        async with client.stream(
            "POST", url, params={"alt": "sse"}, headers=headers, json=body
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                payload = json.loads(line[6:])
                if metrics is not None:
                    usage = payload.get("usageMetadata") or {}
                    for name in ("promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount"):
                        if isinstance(usage.get(name), int):
                            metrics[name] = usage[name]
                    if isinstance(payload.get("modelVersion"), str):
                        metrics["modelVersion"] = payload["modelVersion"]
                for candidate in payload.get("candidates", [])[:1]:
                    for part in candidate.get("content", {}).get("parts", []):
                        if part.get("text") and not part.get("thought"):
                            yield part["text"]


async def stream_canvas(
    run, brief, text_chunks, *, catalog, previous=None, remember=None, metrics=None
):
    surface_id = f"express-{uuid5(NAMESPACE_URL, run.run_id)}"
    message_id = f"genui:{surface_id}"
    processor = A2uiRequestProcessor(
        catalogs=[catalog],
        format_factory=ExpressFormatFactory(
            surface_id=surface_id, version=catalog.protocol_version, allowed_messages=OPERATIONS
        ),
    )
    previous_canvas = ""
    if previous:
        previous_canvas = f"""
Current canvas
{json.dumps(previous, ensure_ascii=False)}

The canvas above is the prior version. Return a complete replacement while preserving data,
language, component IDs and button actions unless the request asks to change them.
"""
    prompt = f"""{processor.prompt_snippet}

{previous_canvas}
Request
{brief}
"""
    stream = processor.open_stream()
    compiled_surface_id = None

    def publish(parts):
        nonlocal compiled_surface_id
        for part in parts:
            if not isinstance(part, A2uiPart):
                continue
            for op in to_message_dicts(part.a2ui):
                action = next((key for key in OPERATIONS if key in op), None)
                if not action or not op[action].get("surfaceId"):
                    raise ValueError("Unexpected Express surface operation")
                source_id = op[action]["surfaceId"]
                op[action]["surfaceId"] = surface_id
                if compiled_surface_id is None:
                    if action != "createSurface":
                        raise ValueError("Express did not create the surface first")
                    compiled_surface_id = source_id
                    yield ActivitySnapshotEvent(
                        type="ACTIVITY_SNAPSHOT",
                        activity_type=ACTIVITY,
                        message_id=message_id,
                        replace=True,
                        content={
                            "surfaceId": surface_id,
                            "catalogId": catalog.catalog_id,
                            "target": "canvas",
                            "status": "streaming",
                            "operations": [op],
                        },
                    )
                else:
                    if source_id != compiled_surface_id or action == "createSurface":
                        raise ValueError("Express attempted to draw more than one surface")
                    yield ActivityDeltaEvent(
                        type="ACTIVITY_DELTA",
                        activity_type=ACTIVITY,
                        message_id=message_id,
                        patch=[{"op": "add", "path": "/operations/-", "value": op}],
                    )

    def status(value):
        patch = [{"op": "replace", "path": "/status", "value": value}]
        if value == "ready" and metrics:
            patch.append({"op": "add", "path": "/metrics", "value": metrics})
        return ActivityDeltaEvent(
            type="ACTIVITY_DELTA",
            activity_type=ACTIVITY,
            message_id=message_id,
            patch=patch,
        )

    yield RunStartedEvent(type="RUN_STARTED", thread_id=run.thread_id, run_id=run.run_id)
    try:
        async with aclosing(text_chunks(prompt)) as chunks:
            async for text in chunks:
                for event in publish(stream.feed(text)):
                    yield event
        for event in publish(stream.close()):
            yield event
        if compiled_surface_id is None:
            raise ValueError("Express did not produce a surface")
        if remember:
            surface = stream.state.get_surface(compiled_surface_id)
            remember({
                "components": [item.component_tree for item in surface.components_model.values],
                "dataModel": surface.data_model.get("/"),
            })
    except (A2uiError, ValueError, httpx.HTTPError) as error:
        _logger.warning("Express canvas run %s failed: %s", run.run_id, type(error).__name__)
        if compiled_surface_id is not None:
            yield status("error")
        yield RunErrorEvent(
            type="RUN_ERROR", code="EXPRESS_CANVAS_FAILED", message="The Express canvas could not finish."
        )
        return
    yield status("ready")
    yield RunFinishedEvent(type="RUN_FINISHED", thread_id=run.thread_id, run_id=run.run_id)

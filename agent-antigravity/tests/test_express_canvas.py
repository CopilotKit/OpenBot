import asyncio
import json
import sys
from pathlib import Path

import httpx
from ag_ui.core import RunAgentInput

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.express_canvas import express_brief, gemini_text_chunks, stream_canvas
from src.express_catalog import catalog_from_offer

_COMMON = "common_types.json#/$defs/"


def _component(name, properties, required=()):
    return {
        "type": "object",
        "properties": {"component": {"const": name}, **properties},
        "required": ["component", *required],
    }


def _dynamic(schema):
    return {"anyOf": [
        schema, {"$ref": _COMMON + "DataBinding"}, {"$ref": _COMMON + "FunctionCall"},
    ]}


_TEST_CATALOG = catalog_from_offer({
    "catalogId": "test/ui",
    "protocolVersion": "1.0",
    "components": {
        "Text": _component("Text", {"text": {"type": "string"}}, ["text"]),
        "Column": _component("Column", {"children": {"$ref": _COMMON + "ChildList"}}),
    },
})


def _run(prompt, targets=("chat", "canvas")):
    return RunAgentInput.model_validate({
        "threadId": "thread", "runId": "run", "state": {}, "context": [],
        "forwardedProps": {},
        "messages": [{"id": "user", "role": "user", "content": prompt}],
        "tools": [{"name": "render_ui", "description": "Draw", "parameters": {
            "type": "object", "properties": {"target": {"enum": list(targets)}},
        }}],
    })


def test_express_requires_an_explicit_request_and_an_available_canvas():
    assert express_brief(_run("Express: Make a chart")) == "Make a chart"
    assert express_brief(_run("Make a chart")) is None
    assert express_brief(_run("Express: Make a chart", targets=("chat",))) is None


def test_canvas_starts_before_the_model_finishes_and_uses_one_activity():
    async def check():
        received = []

        async def chunks(_prompt):
            yield '<a2ui>\nsurface("model-chosen-id")\nheadline = Text("Overview")\nroot = Column([headline])\n'
            assert any(event.type == "ACTIVITY_SNAPSHOT" for event in received)
            yield 'detail = Text("Details")\nroot = Column([headline, detail])\n</a2ui>'

        async for event in stream_canvas(
            _run("Express: Dashboard"), "Dashboard", chunks, catalog=_TEST_CATALOG
        ):
            received.append(event)

        assert received[0].type == "RUN_STARTED"
        assert received[-1].type == "RUN_FINISHED"
        snapshots = [event for event in received if event.type == "ACTIVITY_SNAPSHOT"]
        deltas = [event for event in received if event.type == "ACTIVITY_DELTA"]
        assert len(snapshots) == 1
        assert snapshots[0].content["target"] == "canvas"
        assert snapshots[0].content["status"] == "streaming"
        assert snapshots[0].content["operations"][0]["createSurface"]["surfaceId"] == snapshots[0].content["surfaceId"]
        assert all(event.message_id == snapshots[0].message_id for event in deltas)
        assert any(
            "updateComponents" in update.value
            for event in deltas[:-1]
            for update in event.patch
        )
        assert deltas[-1].patch[0].path == "/status"
        assert deltas[-1].patch[0].value == "ready"

    asyncio.run(check())


def test_model_request_explicitly_uses_low_thinking(monkeypatch):
    async def check():
        def send(request):
            assert request.url.path.endswith("/gemini-4-hydrogen:streamGenerateContent")
            assert json.loads(request.content)["generationConfig"] == {
                "thinkingConfig": {"thinkingLevel": "LOW"}
            }
            return httpx.Response(
                200,
                text='data: {"candidates":[{"content":{"parts":[{"text":"UI"}]}}]}\n\n',
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(send))
        monkeypatch.setattr(httpx, "AsyncClient", lambda **_: client)
        parts = [part async for part in gemini_text_chunks(
            "Build UI", model="gemini-4-hydrogen", api_key="synthetic", base_url="http://mock"
        )]
        assert parts == ["UI"]

    asyncio.run(check())


def test_edit_receives_previous_canvas_and_saves_new_version():
    async def check():
        prior = {"components": [{"id": "root", "component": "Text", "text": "Q4 goals"}]}
        saved = []

        async def chunks(prompt):
            assert '"text": "Q4 goals"' in prompt
            yield '<a2ui>\nroot = Text("Metas del cuarto trimestre")\n</a2ui>'

        events = [event async for event in stream_canvas(
            _run("Express: Translate"), "Translate", chunks,
            catalog=_TEST_CATALOG, previous=prior, remember=saved.append,
        )]
        assert events[-1].type == "RUN_FINISHED"
        assert saved[0]["components"][0]["text"] == "Metas del cuarto trimestre"
        assert prior["components"][0]["text"] == "Q4 goals"

    asyncio.run(check())


def test_advertised_catalog_supplies_components_slots_actions_and_functions():
    document = {
        "catalogId": "example/ui",
        "protocolVersion": "1.0",
        "components": {
            "Fancy": {
                **_component("Fancy", {
                    "label": _dynamic({"type": "string"}),
                    "children": {"$ref": _COMMON + "ChildList"},
                    "onClick": {"$ref": _COMMON + "Action"},
                }, ["label"]),
                "description": "A component supplied by the app",
            },
            "Panels": _component("Panels", {
                "panels": _dynamic({"type": "array", "items": _dynamic({
                    "type": "object", "properties": {
                        "child": {"$ref": _COMMON + "ComponentId"},
                    },
                })}),
            }, ["panels"]),
        },
        "functions": {
            "example": {
                "type": "object",
                "properties": {"@call": {"const": "example"}, "args": {
                    "type": "object", "properties": {
                        "value": {"type": "number"}, "suffix": {"type": "string"},
                    },
                }},
                "required": ["@call", "args"],
                "returnType": "string",
                "description": "Example function",
            },
        },
    }
    catalog = catalog_from_offer(document)
    assert catalog.to_json()["components"]["Panels"] == document["components"]["Panels"]
    assert set(catalog.to_json()["components"]) == {"Fancy", "Panels"}
    assert set(catalog.to_json()["functions"]) == {"example"}

    async def check():
        async def chunks(prompt):
            assert "A component supplied by the app" in prompt
            assert "A title relevant to the request" not in prompt
            yield (
                '<a2ui>\nitem = Fancy(label=example(value=7, suffix="km"), onClick=Event("clicked"))\n'
                'root = Panels(panels=[{"child": "item"}])\n</a2ui>'
            )

        events = [event async for event in stream_canvas(
            _run("Draw"), "Draw", chunks, catalog=catalog
        )]
        assert events[-1].type == "RUN_FINISHED"
        assert events[1].content["catalogId"] == "example/ui"
        components = events[1].content["operations"][0]["createSurface"]["components"]
        label = next(component["label"] for component in components if component["id"] == "item")
        assert label["args"] == {"value": 7, "suffix": "km"}

    asyncio.run(check())

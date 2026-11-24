import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.canvas_content import CanvasContent, CanvasPatch, apply_content_patch
from src.decision_canvas import DecisionCanvasError, decision_brief, draw, questions_for

_MANIFEST = {"components": {name: {"description": name} for name in (
    "Column", "Title", "Text", "Tabs", "List", "Table", "Chart", "Breakdown",
    "CheckBox", "Button", "Row", "Card", "HtmlView", "TextField",
)}}


def _run(content):
    return SimpleNamespace(messages=[SimpleNamespace(role="user", content=content)])


def _answers(**options):
    return {"answers": {key: {"type": "choice", "choice": value, "confidence": 0.92}
                        for key, value in options.items()}}


def test_decision_is_explicit():
    assert decision_brief(_run("Decision: Show spending")) == "Show spending"
    assert decision_brief(_run("Express: Show spending")) is None
    assert decision_brief(_run("Show spending")) is None


def test_content_schema_cannot_directly_author_components_or_actions():
    with pytest.raises(ValidationError):
        CanvasContent.model_validate({"title": "Test", "sections": [{"heading": "Plan", "component": "Tabs"}]})
    with pytest.raises(ValidationError):
        CanvasContent.model_validate({
            "title": "Test", "sections": [{"heading": "Plan", "paragraphs": ["Go."]}],
            "revisions": [{"label": "Run", "request": "Update the view", "event": "execute"}],
        })


@pytest.mark.parametrize(("subject", "section"), [
    ("Lisbon weekend", "Saturday"),
    ("Community repair clinic", "Basic supplies"),
    ("Reduce build times", "Cold-start measurements"),
])
def test_one_composer_handles_unrelated_topics_and_uses_actual_answers(subject, section):
    content = CanvasContent.model_validate({
        "title": subject, "sections": [
            {"heading": section, "entries": [{"label": "Start", "detail": "Details supplied by the planner"}]},
            {"heading": "Options", "dataset": {"amount_label": "Minutes", "values": [
                {"label": "Current", "amount": 32}, {"label": "Target", "amount": 15},
            ]}},
        ],
        "revisions": [{"label": "Make it lighter", "request": "Reduce the workload, keeping key steps."}],
    })

    async def check():
        async def plan(request, previous):
            assert request == subject and previous is None
            return content, {"outputTokens": 101}

        async def decide(context, questions):
            assert context["content"]["title"] == subject
            assert "HtmlView" in context["catalog"]
            assert "HtmlView" not in questions["items_0"]["criteria"]
            return _answers(layout="Tabs", items_0="Table", data_1="Chart", shape_1="bar")

        result = await draw(_MANIFEST, subject, None, plan, decide)
        by_id = {item["id"]: item for item in result["components"]}
        assert by_id["heading"]["text"] == subject
        assert by_id["layout"]["tabs"][0]["title"] == section
        assert by_id["items_0"]["component"] == "Table"
        assert by_id["data_1"]["data"][1]["value"] == 15
        assert by_id["revision_0"]["onClick"]["event"]["userMessage"] == "Reduce the workload, keeping key steps."
        assert result["metrics"]["planner"]["outputTokens"] == 101

    asyncio.run(check())


def test_form_fields_use_decision_for_free_text_and_bind_blank_values():
    content = CanvasContent.model_validate({
        "title": "Workshop registration", "sections": [{"heading": "Contact", "fields": [
            {"label": "Name", "required": True},
            {"label": "Email address", "kind": "email", "required": True},
            {"label": "Accessibility needs"},
        ]}],
    })

    async def check():
        async def plan(_request, _previous):
            return content, {}

        async def decide(_context, questions):
            assert set(questions) == {"field_0_0", "field_0_2"}
            return _answers(field_0_0="shortText", field_0_2="longText")

        result = await draw(_MANIFEST, "Create a registration form", None, plan, decide)
        by_id = {item["id"]: item for item in result["components"]}
        assert by_id["field_0_0"]["required"] is True
        assert by_id["field_0_1"]["variant"] == "email"
        assert by_id["field_0_2"]["variant"] == "longText"
        assert by_id["field_0_2"]["value"] == {"@path": "/fields_0/2"}
        assert result["data"]["fields_0"] == ["", "", ""]

        without_text_field = {"components": {name: schema for name, schema
                              in _MANIFEST["components"].items() if name != "TextField"}}
        with pytest.raises(DecisionCanvasError, match="TextField"):
            await draw(without_text_field, "Create a registration form", None, plan, decide)

    asyncio.run(check())


def test_editable_values_are_bound_and_only_offered_when_capability_exists():
    content = CanvasContent.model_validate({"title": "What-if", "sections": [{
        "heading": "Adjust the parts", "dataset": {"amount_label": "Cost", "currency": "USD", "editable": True,
          "values": [{"label": "A", "amount": 10}, {"label": "B", "amount": 20}]},
        "track_completion": True, "entries": [{"label": "Check prices", "checked": False}],
    }]})

    async def check():
        async def plan(_request, previous):
            assert previous == content.model_dump()
            return content, {}

        async def decide(_context, questions):
            pytest.fail(f"These slots each have one eligible builder: {questions}")

        context, questions, fixed = questions_for(_MANIFEST, "Edit the values", content)
        assert "Breakdown" in context["catalog"]
        assert not questions
        assert fixed == {"items_0": "CheckBox", "data_0": "Breakdown"}
        result = await draw(_MANIFEST, "Edit the values", content.model_dump(), plan, decide)
        by_id = {item["id"]: item for item in result["components"]}
        assert by_id["data_0"]["items"] == {"@path": "/values_0"}
        assert result["data"]["values_0"][1] == {"label": "B", "amount": 20}
        assert result["data"]["checks_0"] == [False]

    asyncio.run(check())


def test_invalid_or_unsupported_answers_never_become_wire_components():
    content = CanvasContent.model_validate({
        "title": "Example", "sections": [{"heading": "Choices", "entries": [{"label": "One"}]}],
    })

    async def check():
        async def plan(_request, _previous):
            return content, {}

        for selected in ("HtmlView", "no_match"):
            async def decide(_context, _questions):
                return _answers(items_0=selected)

            with pytest.raises(DecisionCanvasError):
                await draw(_MANIFEST, "Example", None, plan, decide)

    asyncio.run(check())


def test_patch_revises_only_targeted_sections_and_preserves_the_rest():
    current = CanvasContent.model_validate({"title": "Weekend", "sections": [
        {"heading": "Friday", "paragraphs": ["Preserve first day."]},
        {"heading": "Saturday", "paragraphs": ["Busy day."]},
        {"heading": "Sunday", "paragraphs": ["Preserve last day."]},
        {"heading": "Alternatives", "paragraphs": ["Keep the rain plan."]},
    ]})
    patch = CanvasPatch.model_validate({"edits": [
        {"index": 1, "section": {"heading": "Saturday", "paragraphs": ["Two stops."]}},
    ]})
    result = apply_content_patch(current, patch)
    assert [section.heading for section in result.sections] == [section.heading for section in current.sections]
    assert result.sections[1].paragraphs == ["Two stops."]
    assert result.sections[2:] == current.sections[2:]
    assert current.sections[1].paragraphs == ["Busy day."]

    invalid = CanvasPatch.model_validate({"edits": [{"index": 7, "section": None}]})
    with pytest.raises(ValueError, match="unknown section"):
        apply_content_patch(current, invalid)

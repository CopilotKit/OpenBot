"""Compose neutral content into OpenBot canvases with Gemini Decision 1."""

import json
import logging
from time import perf_counter
from uuid import NAMESPACE_URL, uuid5

import httpx
from a2ui.core import A2uiError
from a2ui.utils.renderer_state import RendererState
from ag_ui.core import ActivitySnapshotEvent, RunErrorEvent, RunFinishedEvent, RunStartedEvent

from .express_canvas import ACTIVITY

MODEL = "gemini-decision-1"
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/decisions"
_log = logging.getLogger("uvicorn.error")
_BASE = {"Column", "Title", "Text"}
_PRESENTATION = {
    "Column": "Keep sections or full-detail entries visible vertically in sequence.",
    "Tabs": "Give distinct peer sections their own panel and a short navigation label.",
    "List": "Show entries as scannable, titled rows with their detail.",
    "Table": "Align the available text or numeric fields in labeled columns for exact comparison.",
    "Chart": "Visualize the supplied series to show a comparison, share, or trend.",
    "CheckBox": "Show independently editable completion flags for these entries.",
    "Breakdown": "Show editable amounts and a live total from the supplied parts.",
}


class DecisionCanvasError(ValueError):
    pass


def decision_brief(run):
    if not run.messages or run.messages[-1].role != "user":
        return None
    content = run.messages[-1].content
    if not isinstance(content, str):
        return None
    prefix, separator, brief = content.strip().partition(":")
    if separator and prefix.casefold() in {"decision", "decision 1", "decision-1"}:
        return brief.strip()
    return None


def _editable(dataset):
    return dataset.editable and 2 <= len(dataset.values) <= 6 and all(
        value.amount >= 0 for value in dataset.values
    )


def _slot_options(components, content):
    options = {}
    if len(content.sections) > 1:
        options["layout"] = (
            "Choose how to navigate the complete canvas. Tabs suit distinct peer sections the user "
            "will revisit individually. Column keeps a sequence or cross-section comparison visible. "
            "Honor the user's explicit request for tabs or a visible stack.",
            ("Column", "Tabs"),
        )
    for index, section in enumerate(content.sections):
        label = f"section {index + 1} ({section.heading})"
        if section.fields and "TextField" not in components:
            raise DecisionCanvasError("The canvas catalog has no TextField for editable form inputs.")
        for position, field in enumerate(section.fields):
            kinds = {
                "text": {
                    "shortText": "Single-line input for a brief value, such as a name.",
                    "longText": "Multiline input for a note or a longer description.",
                },
                "email": {"email": "Email address input."},
                "number": {"number": "Numeric input."},
            }
            options[f"field_{index}_{position}"] = (
                f"Choose the input format for {field.label} in {label}.", kinds[field.kind],
            )
        if section.entries:
            kinds = ("List", "Table", "Column")
            if section.track_completion:
                kinds = ("CheckBox",)
            options[f"items_{index}"] = (
                f"Choose how to show the {len(section.entries)} titled entries in {label}. "
                "The choices all display the entries. Prefer the one most helpful for the request.",
                kinds,
            )
        if section.dataset:
            if _editable(section.dataset) and "Breakdown" in components:
                options[f"data_{index}"] = (
                    f"Choose a component for the editable parts and live total in {label}.",
                    ("Breakdown",),
                )
                continue
            options[f"data_{index}"] = (
                f"Choose the presentation of the dataset in {label}. Choose Chart for a requested "
                "visual comparison or pattern, Table for exact values or a small set of estimates.",
                ("Table", "Chart"),
            )
            if "Chart" in components:
                shapes = {
                    "bar": "Compare amounts across distinct items or discrete time periods.",
                    "line": "Show a trend in naturally ordered observations.",
                }
                amounts = [value.amount for value in section.dataset.values]
                if all(amount >= 0 for amount in amounts) and any(amounts):
                    shapes["pie"] = "Show how nonnegative categories divide a whole."
                options[f"shape_{index}"] = (
                    f"If displaying a chart for {label}, select its type. Honor a requested chart type when offered.",
                    shapes,
                )
    return options


def questions_for(manifest, brief, content):
    components = manifest["components"]
    if not _BASE.issubset(components):
        raise DecisionCanvasError("The canvas catalog is missing the common layout components.")
    descriptions = {name: item.get("description") or name for name, item in components.items()}
    questions = {}
    fixed = {}
    for slot, (instructions, candidates) in _slot_options(components, content).items():
        if isinstance(candidates, dict):
            criteria = candidates
        else:
            criteria = {name: _PRESENTATION[name] for name in candidates if name in descriptions}
        if not criteria:
            raise DecisionCanvasError(f"The canvas catalog has no supported component for {slot}.")
        if len(criteria) == 1:
            fixed[slot] = next(iter(criteria))
        else:
            questions[slot] = {"type": "choice", "instructions": instructions, "criteria": criteria}
    return {"request": brief, "catalog": descriptions, "content": content.model_dump()}, questions, fixed


async def gemini_decisions(context, questions, *, api_key):
    async with httpx.AsyncClient(timeout=httpx.Timeout(30, connect=10)) as client:
        response = await client.post(
            ENDPOINT, headers={"x-goog-api-key": api_key}, json={
                "model": MODEL, "input": json.dumps(context, ensure_ascii=False), "questions": questions,
            },
        )
        response.raise_for_status()
        return response.json()


def _picked(response, questions, key):
    answer = response["answers"].get(key, {})
    if not isinstance(answer, dict) or answer.get("type") != "choice":
        raise DecisionCanvasError(f"Decision 1 did not return a valid answer for {key}.")
    choice = answer.get("choice")
    confidence = answer.get("confidence")
    if not isinstance(choice, str) or choice not in questions[key]["criteria"]:
        raise DecisionCanvasError(f"Decision 1 selected an unavailable option for {key}.")
    if type(confidence) not in (float, int) or not 0 <= confidence <= 1:
        raise DecisionCanvasError(f"Decision 1 returned invalid confidence for {key}.")
    # Layout preferences can be close. Every offered recipe is validated and bounded.
    return {"choice": choice, "confidence": confidence}


def _component(ident, kind, **props):
    return {"id": ident, "component": kind, **props}


def _compile_entries(index, entries, kind, data):
    ident = f"items_{index}"
    if kind == "List":
        rows = [{"label": entry.label, "description": entry.detail} for entry in entries]
        return [_component(ident, kind, items=rows)]
    if kind == "Table":
        return [_component(ident, kind, columns=["Item", "Details"],
                           rows=[[entry.label, entry.detail] for entry in entries])]

    children = []
    pieces = []
    if kind == "CheckBox":
        key = f"checks_{index}"
        data[key] = [entry.checked is True for entry in entries]
        for position, entry in enumerate(entries):
            child = f"{ident}_{position}"
            # Keep the note with its associated checkbox.
            label = f"{entry.label} — {entry.detail}" if entry.detail else entry.label
            children.append(child)
            pieces.append(_component(child, kind, label=label, value={"@path": f"/{key}/{position}"}))
    else:
        for position, entry in enumerate(entries):
            label, detail = f"{ident}_{position}_label", f"{ident}_{position}_detail"
            children.append(label)
            pieces.append(_component(label, "Text", text=entry.label, strong=True))
            if entry.detail:
                children.append(detail)
                pieces.append(_component(detail, "Text", text=entry.detail))
    return [_component(ident, "Column", children=children), *pieces]


def _compile_dataset(index, dataset, kind, data, pick):
    ident = f"data_{index}"
    if kind == "Breakdown":
        key = f"values_{index}"
        data[key] = [value.model_dump() for value in dataset.values]
        props = {"currency": dataset.currency} if dataset.currency else {"unit": dataset.unit}
        return _component(ident, kind, items={"@path": f"/{key}"}, **props)
    if kind == "Chart":
        return _component(
            ident, kind, chartType=pick(f"shape_{index}"), xKey="label",
            data=[{"label": value.label, "value": value.amount} for value in dataset.values],
            series=[{"key": "value", "label": dataset.amount_label}],
            **({"format": "currency", "currency": dataset.currency} if dataset.currency else {}),
        )

    unit = dataset.currency or dataset.unit
    measure = f"{dataset.amount_label} ({unit})" if unit else dataset.amount_label
    return _component(ident, "Table", columns=["Item", measure],
                      rows=[[value.label, value.amount] for value in dataset.values])


def _compile(content, manifest, pick):
    data = {}
    components = [_component("heading", "Title", text=content.title, size="xl")]
    root = ["heading"]
    if content.summary:
        root.append("summary")
        components.append(_component("summary", "Text", text=content.summary))
    mode = pick("layout") if len(content.sections) > 1 else "Column"
    sections = []
    for index, section in enumerate(content.sections):
        ident = f"section_{index}"
        sections.append(ident)
        children = []
        if mode == "Column":
            children.append(f"section_heading_{index}")
            components.append(_component(children[-1], "Title", text=section.heading))
        for position, paragraph in enumerate(section.paragraphs):
            if paragraph:
                children.append(f"copy_{index}_{position}")
                components.append(_component(children[-1], "Text", text=paragraph))
        if section.entries:
            children.append(f"items_{index}")
            components.extend(_compile_entries(index, section.entries, pick(children[-1]), data))
        if section.fields:
            key = f"fields_{index}"
            data[key] = [""] * len(section.fields)
            for position, field in enumerate(section.fields):
                child = f"field_{index}_{position}"
                children.append(child)
                components.append(_component(
                    child, "TextField", label=field.label, variant=pick(child),
                    required=field.required, value={"@path": f"/{key}/{position}"},
                ))
        if section.dataset:
            children.append(f"data_{index}")
            components.append(_compile_dataset(index, section.dataset, pick(children[-1]), data, pick))
        components.append(_component(ident, "Column", children=children))

    if mode == "Tabs":
        root.append("layout")
        components.append(_component("layout", mode, tabs=[
            {"title": section.heading, "child": ident}
            for section, ident in zip(content.sections, sections, strict=True)
        ]))
    else:
        root.extend(sections)

    if content.limitation:
        root.append("limitation")
        components.append(_component("limitation", "Text", text=content.limitation))
    if content.revisions and {"Row", "Button"}.issubset(manifest["components"]):
        buttons = []
        for index, revision in enumerate(content.revisions):
            buttons.append(f"revision_{index}")
            components.append(_component(
                buttons[-1], "Button", label=revision.label, onClick={"event": {
                    "name": "revise_canvas", "userMessage": revision.request,
                }},
            ))
        root.append("revisions")
        components.append(_component("revisions", "Row", children=buttons))
    return [_component("root", "Column", children=root), *components], data


async def draw(manifest, brief, previous, plan, decide):
    if not brief or len(brief) > 12_000:
        raise DecisionCanvasError("Enter a canvas request of up to 12,000 characters.")
    started = perf_counter()
    try:
        content, planner_usage = await plan(brief, previous)
    except (ValueError, httpx.HTTPError) as error:
        raise DecisionCanvasError("The content planner could not produce a usable canvas plan.") from error
    plan_ms = round(1000 * (perf_counter() - started), 1)
    if not content.sections:
        raise DecisionCanvasError(content.limitation or "The planner did not produce canvas content.")
    context, questions, fixed = questions_for(manifest, brief, content)

    decision_ms = 0
    usage = {}
    answers = {"answers": {}}
    if questions:
        started = perf_counter()
        try:
            answers = await decide(context, questions)
        except (ValueError, httpx.HTTPError) as error:
            raise DecisionCanvasError("The Decision 1 presentation request failed.") from error
        decision_ms = round(1000 * (perf_counter() - started), 1)
        if not isinstance(answers, dict) or not isinstance(answers.get("answers"), dict):
            raise DecisionCanvasError("Decision 1 did not return a decision batch.")
        usage = answers.get("usage") or {}

    picks = {}

    def pick(slot):
        if slot in fixed:
            return fixed[slot]
        value = _picked(answers, questions, slot)
        picks[slot] = value
        return value["choice"]

    components, data = _compile(content, manifest, pick)
    return {"state": content.model_dump(), "components": components, "data": data, "metrics": {
        "model": MODEL,
        "planner": {**planner_usage, "apiMs": plan_ms},
        "apiMs": decision_ms, "questions": len(questions),
        "catalogComponents": len(manifest["components"]), "decisions": picks,
        "inputTokens": usage.get("total_input_tokens"), "outputTokens": usage.get("total_output_tokens"),
    }}


async def stream_decision_canvas(run, brief, plan, decide, *, catalog, manifest, previous=None, remember=None):
    yield RunStartedEvent(type="RUN_STARTED", thread_id=run.thread_id, run_id=run.run_id)
    started = perf_counter()
    stage = "content or presentation"
    try:
        if catalog is None:
            raise DecisionCanvasError("Open the Canvas pane so it can send its component catalog.")
        result = await draw(manifest, brief, previous, plan, decide)
        stage = "catalog validation"
        surface_id = f"decision-{uuid5(NAMESPACE_URL, run.run_id)}"
        operations = [
            {"version": "1.0", "createSurface": {"surfaceId": surface_id, "catalogId": catalog.catalog_id}},
        ]
        if result["data"]:
            operations.append({
                "version": "1.0", "updateDataModel": {"surfaceId": surface_id, "value": result["data"]},
            })
        operations.append({
            "version": "1.0", "updateComponents": {"surfaceId": surface_id, "components": result["components"]},
        })
        state = RendererState([catalog])
        with state.transaction():
            state.check_topology(state.apply(operations))
        if remember:
            remember(result["state"])
    except (A2uiError, ValueError, httpx.HTTPError) as error:
        _log.warning("Decision canvas run %s failed during %s: %s", run.run_id, stage, type(error).__name__)
        message = str(error) if isinstance(error, DecisionCanvasError) else "The Decision canvas could not finish."
        yield RunErrorEvent(type="RUN_ERROR", code="DECISION_CANVAS_FAILED", message=message)
        return
    metrics = {**result["metrics"], "canvasReadyMs": round(1000 * (perf_counter() - started), 1)}
    yield ActivitySnapshotEvent(
        type="ACTIVITY_SNAPSHOT", activity_type=ACTIVITY, message_id=f"genui:{surface_id}", replace=True,
        content={"surfaceId": surface_id, "catalogId": catalog.catalog_id, "target": "canvas",
                 "status": "ready", "operations": operations, "metrics": metrics},
    )
    yield RunFinishedEvent(type="RUN_FINISHED", thread_id=run.thread_id, run_id=run.run_id)

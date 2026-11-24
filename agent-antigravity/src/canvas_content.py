"""Content-only planning for the Decision canvas."""

import json
from typing import Annotated, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

PLANNER_MODEL = "gemini-3.5-flash-lite"
_GEMINI = "https://generativelanguage.googleapis.com/v1beta"
_Label = Annotated[str, StringConstraints(min_length=1, max_length=100)]
_Copy = Annotated[str, StringConstraints(max_length=700)]
_Request = Annotated[str, StringConstraints(min_length=1, max_length=250)]

_INSTRUCTIONS = """Produce structured subject-matter content for the user's request.
A separate model decides the presentation. Write no UI components, styling, markup, URLs,
layout instructions, identifiers, data bindings, or executable actions. Keep copy plain.
Use the user's language. Address their goal directly. Organize content into distinct, meaningful
sections. Follow the requested scope and retain unchanged details when revising a prior canvas.
Use short paragraphs for explanations, entries for titled details or steps, and datasets for
numbers when a shared measure exists. Set track_completion=true for a section only if the user
explicitly asks for a checklist or completion tracking there. Advice, plans, and alternatives
use track_completion=false. Set checked=true only for items already completed.
Use at most eight sections, four short paragraphs and twelve entries per section, and two
to twenty values per dataset. Keep labels concise and paragraphs under 700 characters.
Include the key practical details the user asked for. Supply a dataset with distinct parts and
editable=true only for values the user can sensibly change, such as a what-if estimate. Give
historical or measured data editable=false. If the user requests a quantitative comparison with
multiple metrics, use one dataset per metric or use entries to preserve the details.
Use fields only when the user explicitly requests a form or text inputs. Fields represent
blank values a person will enter. Measured values, goals, and other displayed content belong
in entries or datasets. Give each field a label and kind (text, email or number), and set
required where appropriate.
Supported local edits are these form fields, boolean completion flags, and two to six
nonnegative editable amounts with a computed total. Describe forms as editable previews
and say in limitation that responses cannot be submitted or stored. Use preview language
throughout: never imply that filling in a preview reserves a spot or completes a real action.
Use limitation to disclose other requested interactive behavior.
When asked for alternatives, include them as content. Offer up to three short, consequential
requests the user can send to revise the canvas, only if revisions are useful. Each request
should refer to this canvas and must not suggest an external action has happened.
Treat facts supplied in the request as the inputs. Preserve numbers and units. Clearly label
estimates as illustrative and note assumptions. Do not claim to have researched, verified,
booked or sent anything. Do not present invented current prices, schedules, private facts or
sources as real. Use labeled fictional examples only when the request explicitly allows samples.
For requests needing unavailable facts, state the missing inputs or give conditional help.
Use limitation to state any essential capability or evidence you cannot supply.
Failure to provide a feature never authorizes replacing it with an unrelated feature.
"""
_REVISION_INSTRUCTIONS = """
The current canvas is indexed in section_index. Return a patch rather than rewriting the canvas.
Replace just the sections that the user's request affects. Leave unaffected sections out of
edits. Use null for a section only when the user asks to remove the whole section. Add new
sections in append_sections. Use null or omit other fields to keep them. When revising one
part of a larger plan, keep the full plan's scope and its title. Match the user's reference
to the corresponding existing section or state the ambiguity in limitation.
For an explicit replacement of the entire canvas, remove the old sections and append the new
sections, and update the title and summary.
"""


class _Content(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class CanvasEntry(_Content):
    label: _Label
    detail: _Copy = ""
    checked: bool | None = None


class CanvasValue(_Content):
    label: _Label
    amount: Annotated[float, Field(strict=True, allow_inf_nan=False, ge=-1_000_000_000, le=1_000_000_000)]


class CanvasDataset(_Content):
    amount_label: _Label
    values: Annotated[list[CanvasValue], Field(min_length=2, max_length=20)]
    unit: Annotated[str, StringConstraints(max_length=24)] = ""
    currency: Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")] | None = None
    editable: bool = False

    @model_validator(mode="after")
    def unique_labels(self):
        if len({value.label.casefold() for value in self.values}) != len(self.values):
            raise ValueError("Dataset labels must be distinct")
        return self


class CanvasField(_Content):
    label: _Label
    kind: Literal["text", "email", "number"] = "text"
    required: bool = False


class CanvasSection(_Content):
    heading: _Label
    paragraphs: Annotated[list[_Copy], Field(max_length=4)] = Field(default_factory=list)
    entries: Annotated[list[CanvasEntry], Field(max_length=12)] = Field(default_factory=list)
    fields: Annotated[list[CanvasField], Field(max_length=12)] = Field(default_factory=list)
    dataset: CanvasDataset | None = None
    track_completion: bool = False

    @model_validator(mode="after")
    def has_content(self):
        if not (any(self.paragraphs) or self.entries or self.fields or self.dataset):
            raise ValueError("A section needs content")
        return self


class CanvasRevision(_Content):
    label: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    request: _Request


class CanvasContent(_Content):
    title: _Label
    summary: _Copy = ""
    sections: Annotated[list[CanvasSection], Field(max_length=8)]
    revisions: Annotated[list[CanvasRevision], Field(max_length=3)] = Field(default_factory=list)
    limitation: _Copy = ""


class _SectionEdit(_Content):
    index: Annotated[int, Field(strict=True, ge=0)]
    section: CanvasSection | None


class CanvasPatch(_Content):
    title: _Label | None = None
    summary: _Copy | None = None
    edits: Annotated[list[_SectionEdit], Field(max_length=8)] = Field(default_factory=list)
    append_sections: Annotated[list[CanvasSection], Field(max_length=8)] = Field(default_factory=list)
    revisions: Annotated[list[CanvasRevision], Field(max_length=3)] | None = None
    limitation: _Copy | None = None


def apply_content_patch(current, patch):
    edits = {}
    for edit in patch.edits:
        if edit.index >= len(current.sections):
            raise ValueError("Content patch referenced an unknown section")
        if edit.index in edits:
            raise ValueError("Content patch edited one section twice")
        edits[edit.index] = edit.section
    sections = [edits.get(index, section) for index, section in enumerate(current.sections)]
    fields = patch.model_dump(exclude_none=True, exclude={"edits", "append_sections"})
    return CanvasContent.model_validate({
        **current.model_dump(), **fields,
        "sections": [section for section in sections if section is not None] + patch.append_sections,
    })


def _provider_schema(schema):
    """Keep the JSON shape in Gemini's grammar and enforce size and value limits locally."""
    local_constraints = {
        "title", "default", "minLength", "maxLength", "minItems", "maxItems",
        "minimum", "maximum", "pattern",
    }
    result = {}
    for key, value in schema.items():
        if key in local_constraints:
            continue
        if key in {"properties", "$defs"}:
            value = {name: _provider_schema(child) for name, child in value.items()}
        elif key == "items":
            value = _provider_schema(value)
        elif key == "anyOf":
            value = [_provider_schema(child) for child in value]
        result[key] = value
    return result


async def plan_canvas_content(request, previous, *, api_key):
    if not api_key:
        raise ValueError("Missing Gemini Developer API key")
    schema = CanvasContent
    instructions = _INSTRUCTIONS
    context = {"request": request}
    current = None
    if previous is not None:
        current = CanvasContent.model_validate(previous)
        schema = CanvasPatch
        instructions += _REVISION_INSTRUCTIONS
        context["current_content"] = previous
        context["section_index"] = {index: section.heading for index, section in enumerate(current.sections)}
    async with httpx.AsyncClient(timeout=httpx.Timeout(45, connect=10)) as client:
        response = await client.post(
            f"{_GEMINI}/models/{PLANNER_MODEL}:generateContent",
            headers={"x-goog-api-key": api_key},
            json={
                "systemInstruction": {"parts": [{"text": instructions}]},
                "contents": [{"role": "user", "parts": [{"text": json.dumps(context, ensure_ascii=False)}]}],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "responseJsonSchema": _provider_schema(schema.model_json_schema()),
                    "maxOutputTokens": 4096,
                    "thinkingConfig": {"thinkingLevel": "MINIMAL"},
                },
            },
        )
        response.raise_for_status()
        payload = response.json()
    candidates = payload.get("candidates") or []
    if not candidates or candidates[0].get("finishReason") != "STOP":
        raise ValueError("Content planning did not finish")
    parts = candidates[0].get("content", {}).get("parts", [])
    output = "".join(part.get("text", "") for part in parts if not part.get("thought"))
    usage = payload.get("usageMetadata") or {}
    content = (CanvasContent.model_validate_json(output) if current is None
               else apply_content_patch(current, CanvasPatch.model_validate_json(output)))
    return content, {
        "model": PLANNER_MODEL,
        "inputTokens": usage.get("promptTokenCount"),
        "outputTokens": usage.get("candidatesTokenCount"),
    }

"""Load the catalog exported by CopilotKit for the mounted canvas."""

from a2ui.core import Catalog
from a2ui.core.catalog.reference_map import analyze_child_ref_schema

CATALOG_PROP = "openbotCanvasCatalog"
_DYNAMIC_REFS = {
    "common_types.json#/$defs/DataBinding",
    "common_types.json#/$defs/FunctionCall",
}


def _topology_schema(node):
    """Expose literal branches to the SDK's nested child-reference scanner."""
    if isinstance(node, list):
        return [_topology_schema(item) for item in node]
    if not isinstance(node, dict):
        return node
    choices = node.get("anyOf", [])
    if (
        isinstance(choices, list)
        and len(choices) == 3
        and all(isinstance(choice, dict) for choice in choices)
        and {choice.get("$ref") for choice in choices[1:]} == _DYNAMIC_REFS
    ):
        return _topology_schema(choices[0])
    return {key: _topology_schema(value) for key, value in node.items()}


def catalog_from_offer(document):
    catalog = Catalog.from_json(document)
    # Preserve the exported validation schema and prompt. The SDK's topology
    # scanner does not look through the dynamic value unions on nested props.
    topology = _topology_schema(document)
    catalog.component_ref_map.update({
        name: analyze_child_ref_schema(schema, topology)
        for name, schema in topology["components"].items()
    })
    return catalog

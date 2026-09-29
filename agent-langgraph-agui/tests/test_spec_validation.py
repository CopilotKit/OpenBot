"""The spec file's validation, exercised the way the TypeScript loader exercises it.

`shared/model-providers.json` is one file, but `shared/model-providers.ts` and
`shared/model_providers.py` each keep their own list of the providers they have heard of and check
the file against their own list in both directions. This test is the Python half of that. Each case
imports the loader in a subprocess against a file written to `tmp_path`, so a refusal here cannot
leave a half-loaded module behind for the tests beside it, and the words asserted are the words the
TypeScript loader says for the same file.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SHARED = Path(__file__).resolve().parents[2] / "shared"

sys.path.insert(0, str(SHARED))
from model_providers import PROVIDER_IDS

_PROVIDER_FIELDS = {
    "key_variable": "SOME_API_KEY",
    "base_url_variable": "SOME_BASE_URL",
    "default_model": "some-model",
}


def _spec():
    """A file this module accepts, for a test to take one thing out of."""
    return {
        "providers": {
            provider_id: {**_PROVIDER_FIELDS, "label": provider_id.title()}
            for provider_id in PROVIDER_IDS
        },
        "bots": {"agent-x": {"provider": "openai", "model": "gpt-5.5"}},
    }


def _import(spec, tmp_path, shipped=False):
    """Import the loader against `spec`, or against the file in the repository when `shipped`."""
    environment = dict(os.environ)
    environment.pop("BOT_SPEC_PATH", None)
    if not shipped:
        path = tmp_path / "model-providers.json"
        path.write_text(json.dumps(spec), encoding="utf-8")
        environment["BOT_SPEC_PATH"] = str(path)
    environment["PYTHONPATH"] = str(SHARED) + os.pathsep + environment.get("PYTHONPATH", "")
    return subprocess.run(
        [sys.executable, "-c", "import model_providers"],
        cwd=str(tmp_path),
        env=environment,
        text=True,
        capture_output=True,
    )


def _refusal(spec, tmp_path):
    """The words the loader refused `spec` with."""
    result = _import(spec, tmp_path)
    assert result.returncode != 0, "the loader accepted a file it should have refused."
    return result.stderr


def test_the_file_in_the_repository_is_one_this_module_accepts(tmp_path):
    result = _import(None, tmp_path, shipped=True)
    assert result.returncode == 0, result.stderr

    declared = json.loads(
        (SHARED / "model-providers.json").read_text(encoding="utf-8")
    )["providers"]
    assert set(declared) == set(PROVIDER_IDS)


@pytest.mark.parametrize("missing", PROVIDER_IDS)
def test_a_provider_row_the_list_names_may_not_be_dropped(tmp_path, missing):
    spec = _spec()
    del spec["providers"][missing]
    assert f"providers is missing its {missing} row." in _refusal(spec, tmp_path)


def test_a_provider_row_the_list_has_never_heard_of_is_refused(tmp_path):
    spec = _spec()
    spec["providers"]["mistral"] = {**_PROVIDER_FIELDS, "label": "Mistral"}
    assert (
        "providers has a mistral row this module has never heard of."
        in _refusal(spec, tmp_path)
    )


def test_a_bot_naming_a_provider_the_list_has_never_heard_of_is_refused(tmp_path):
    spec = _spec()
    spec["bots"]["agent-x"]["provider"] = "mistral"
    assert (
        'bots.agent-x.provider is "mistral", not one of openai, anthropic, google.'
        in _refusal(spec, tmp_path)
    )

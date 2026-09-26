"""Exercise learned skill reads through the real bundled framework."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "agent-agno"))

from learning_harness_contract import assert_learning_delivery


def test_learned_catalog_and_both_read_tools_reach_the_model(monkeypatch):
    assert_learning_delivery(monkeypatch, "agent-agno", "/agui")

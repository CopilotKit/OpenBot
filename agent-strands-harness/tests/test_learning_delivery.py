"""AWS Strands harness receives OpenBot's learned context and read tools."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "agent-strands-harness"))

from learning_harness_contract import assert_learning_delivery


def test_learned_catalog_and_both_read_tools_reach_the_model(monkeypatch):
    assert_learning_delivery(monkeypatch, "agent-strands-harness", "/")

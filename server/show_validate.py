"""Validation for Grok show scripts (P3 calls this before rendering audio).

Per team decision: no strict number matching. Grok gets a rounded price table;
we only enforce (1) assets are on the allowlist and (2) no recommendation language.
"""
from __future__ import annotations

import re

from pydantic import ValidationError

from .allowlist import ASSETS
from .contract import GrokScript

_RECOMMEND = re.compile(
    r"\b(you\s+should|should\s+(buy|sell|get\s+in|grab)|recommend\w*|go\s+buy|buy\s+now|sell\s+now|"
    r"don'?t\s+miss|load\s+up|backup\s+the\s+truck|financial\s+advice\s+is|guaranteed|can'?t\s+lose)\b",
    re.IGNORECASE,
)


def validate_script(raw: str | dict) -> tuple[GrokScript | None, str | None]:
    """Returns (script, None) if usable, else (None, reason)."""
    try:
        script = GrokScript.model_validate_json(raw) if isinstance(raw, str) else GrokScript.model_validate(raw)
    except ValidationError as e:
        return None, f"bad json: {e.errors()[0]['msg']}"
    script.assets_mentioned = [a.upper() for a in script.assets_mentioned]
    script.big_movers = [a.upper() for a in script.big_movers]
    unknown = [a for a in script.assets_mentioned + script.big_movers if a not in ASSETS]
    if unknown:
        return None, f"assets not on allowlist: {unknown}"
    for ln in script.lines:
        if _RECOMMEND.search(ln.line):
            return None, f"recommendation language: {ln.line!r}"
    return script, None

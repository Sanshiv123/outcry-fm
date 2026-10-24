"""Confirmation intents: single-use, expire after a TTL, invalidated by any change.

A user has at most one live intent. Creating a new one (different asset, side or amount)
supersedes the old one, so "confirm" can only ever execute what was last read back.
"""
from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Callable

SPOKEN = {
    "NOT_FOUND": "I don't have an order waiting for you to confirm.",
    "INTENT_EXPIRED": "That order timed out. Tell me again and I'll read it back.",
    "INTENT_USED": "That one was already sent to the floor.",
    "INTENT_MISMATCH": "The order changed, so I need to read it back again before you confirm.",
}


class IntentError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code
        self.spoken = SPOKEN[code]


@dataclass
class Intent:
    intent_id: str
    user_id: str
    kind: str
    symbol: str
    usd_amount: Decimal
    created_at: float
    expires_at: float
    payload: Any = None  # e.g. the Gateway quote
    used: bool = False
    superseded: bool = False


@dataclass
class IntentStore:
    ttl_s: int = 30
    clock: Callable[[], float] = time.time
    _intents: dict[str, Intent] = field(default_factory=dict)

    def create(self, user_id: str, kind: str, symbol: str, usd_amount: Decimal, payload=None) -> Intent:
        for it in self._intents.values():
            if it.user_id == user_id and not it.used:
                it.superseded = True
        now = self.clock()
        it = Intent("int-" + secrets.token_hex(6), user_id, kind, symbol, Decimal(usd_amount),
                    now, now + self.ttl_s, payload)
        self._intents[it.intent_id] = it
        return it

    def consume(self, intent_id: str, user_id: str, kind: str | None = None,
                symbol: str | None = None, usd_amount: Decimal | None = None) -> Intent:
        """Atomic in asyncio (no awaits): check everything, then mark used."""
        it = self._intents.get(intent_id)
        if it is None or it.user_id != user_id:
            raise IntentError("NOT_FOUND")
        if it.used:
            raise IntentError("INTENT_USED")
        if it.superseded:
            raise IntentError("INTENT_MISMATCH")
        if self.clock() > it.expires_at:
            raise IntentError("INTENT_EXPIRED")
        if ((kind is not None and kind != it.kind)
                or (symbol is not None and symbol.upper() != it.symbol)
                or (usd_amount is not None and Decimal(usd_amount) != it.usd_amount)):
            raise IntentError("INTENT_MISMATCH")
        it.used = True
        return it

"""In-memory users + order ledger (hackathon scope; DATABASE_URL unused for now)."""
from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from decimal import Decimal

from .gateway.base import UserRef, WalletInfo

COUNTS_TOWARD_CAP = {"pending", "filled", "unknown"}  # unknown counts: fail safe
DAY_S = 24 * 3600


@dataclass
class LedgerEntry:
    intent_id: str
    kind: str
    symbol: str
    usd_amount: Decimal
    status: str
    created_at: float
    ref_id: str | None = None  # order_id or transfer_id


@dataclass
class User:
    user_id: str
    first_name: str
    email: str
    session: str
    gateway_ref: str | None
    wallets: list[WalletInfo]
    ledger: list[LedgerEntry] = field(default_factory=list)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def ref(self) -> UserRef:
        return UserRef(self.user_id, self.gateway_ref)

    def daily_used(self, now: float | None = None) -> Decimal:
        now = time.time() if now is None else now
        return sum((e.usd_amount for e in self.ledger
                    if e.status in COUNTS_TOWARD_CAP and now - e.created_at < DAY_S), Decimal(0))


class UserStore:
    def __init__(self):
        self.by_id: dict[str, User] = {}
        self.by_session: dict[str, User] = {}
        self.funded_count = 0

    def new_ids(self) -> tuple[str, str]:
        return "u-" + secrets.token_hex(4), secrets.token_urlsafe(24)

    def add(self, user: User):
        self.by_id[user.user_id] = user
        self.by_session[user.session] = user

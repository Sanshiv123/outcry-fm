"""Gateway backend interface.

Both the mock and the real True Markets adapter implement `GatewayBackend`.
`UserRef.gateway_ref` is opaque so the same interface works whichever wallet model
True Markets confirms (org-managed wallets signed by our key, or per-user accounts).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Literal, Protocol

Status = Literal["pending", "filled", "failed", "unknown"]


class GatewayError(Exception):
    """The Gateway definitely did not execute the request."""


class GatewayUncertain(GatewayError):
    """The request may have executed (timeout, dropped connection).
    Callers must query status with `ref_id` — never resubmit."""

    def __init__(self, msg: str, ref_id: str | None = None):
        super().__init__(msg)
        self.ref_id = ref_id


@dataclass
class UserRef:
    user_id: str
    gateway_ref: str | None  # wallet-model specific handle; None for the station wallet


@dataclass
class WalletInfo:
    chain: str
    address: str


@dataclass
class PriceSnap:
    symbol: str
    price_usd: Decimal
    change_24h_pct: Decimal | None
    as_of: datetime


@dataclass
class Quote:
    symbol: str
    side: Literal["buy", "sell"]
    usd_amount: Decimal
    qty: Decimal
    price_usd: Decimal
    fee_usd: Decimal
    total_usd: Decimal          # buy: usd + fee paid; sell: usd - fee received
    quote_ref: str | None = None  # Gateway quote/order handle if the real API needs one


@dataclass
class OrderResult:
    order_id: str
    status: Status
    filled_qty: Decimal | None = None
    avg_price_usd: Decimal | None = None
    fee_usd: Decimal | None = None


@dataclass
class TransferResult:
    transfer_id: str
    status: Status


class GatewayBackend(Protocol):
    simulated: bool

    async def create_wallets(self, user_id: str) -> tuple[str, list[WalletInfo]]: ...
    async def get_prices(self, symbols: list[str]) -> dict[str, PriceSnap]: ...
    async def get_price_history(self, symbol: str, range_: str) -> list[tuple[datetime, Decimal]]: ...
    async def get_balances(self, user: UserRef) -> dict[str, Decimal]: ...
    async def get_quote(self, user: UserRef, symbol: str, side: str, usd_amount: Decimal) -> Quote: ...
    async def place_order(self, user: UserRef, quote: Quote, client_ref: str) -> OrderResult: ...
    async def get_order_status(self, user: UserRef, order_id: str) -> OrderResult: ...
    async def transfer_to_station(self, user: UserRef, symbol: str, qty: Decimal, client_ref: str) -> TransferResult: ...
    async def fund_from_station(self, user: UserRef, symbol: str, qty: Decimal, client_ref: str) -> TransferResult: ...
    async def get_transfer_status(self, user: UserRef, transfer_id: str) -> TransferResult: ...

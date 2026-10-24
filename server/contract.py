"""OUTCRY.FM shared contract — the single source of truth for P1–P4.

All money fields are Decimal and serialize to JSON *strings* ("1.00").
Every response carries `simulated` so the UI can label MOCK_MODE output "SIMULATED".
Change this file only with the whole team's agreement.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, Field

Side = Literal["buy", "sell"]
Kind = Literal["buy", "sell", "tip"]
Channel = Literal["screen", "one_tap", "call", "ptt"]
OrderStatus = Literal["pending", "filled", "failed", "unknown"]
ReasonCode = Literal[
    "MAX_ORDER", "DAILY_CAP", "NOT_ALLOWED", "NO_PRICE", "NO_BALANCE", "BAD_AMOUNT",
    "INTENT_EXPIRED", "INTENT_USED", "INTENT_MISMATCH", "NOT_FOUND",
    "GATEWAY_ERROR", "UNAUTHORIZED",
]


# ---------- errors ----------
class ErrorResponse(BaseModel):
    error: str
    reason_code: ReasonCode
    spoken_reason: str


# ---------- signup / me ----------
class Wallet(BaseModel):
    chain: str
    address: str


class SignupRequest(BaseModel):
    first_name: str = Field(min_length=1, max_length=40)
    email: str = Field(min_length=3, max_length=200)


class SignupResponse(BaseModel):
    user_id: str
    first_name: str
    wallets: list[Wallet]
    session: str  # send as `Authorization: Bearer <session>`
    funded: bool
    funding_transfer_id: Optional[str] = None
    simulated: bool


class Balance(BaseModel):
    symbol: str
    qty: Decimal
    usd_value: Optional[Decimal] = None


class MeResponse(BaseModel):
    user_id: str
    first_name: str
    wallets: list[Wallet]
    balances: list[Balance]
    daily_used_usd: Decimal
    daily_cap_usd: Decimal
    max_order_usd: Decimal
    simulated: bool


# ---------- market data ----------
class AssetPrice(BaseModel):
    symbol: str
    name: str
    spoken_name: str
    price_usd: Decimal
    change_24h_pct: Optional[Decimal] = None


class PricesResponse(BaseModel):
    as_of: datetime
    assets: list[AssetPrice]
    simulated: bool


class PricePoint(BaseModel):
    t: datetime
    price_usd: Decimal


class HistoryResponse(BaseModel):
    symbol: str
    range: str
    points: list[PricePoint]
    simulated: bool


# ---------- intent -> confirm (all trades and tips) ----------
class IntentRequest(BaseModel):
    kind: Kind
    symbol: str
    usd_amount: Decimal  # validated by the policy layer, not here, so blocks are speakable
    channel: Channel


class IntentResponse(BaseModel):
    blocked: Literal[False] = False
    intent_id: str
    kind: Kind
    symbol: str
    usd_amount: Decimal
    est_qty: Decimal
    price_usd: Decimal
    fee_usd: Decimal
    total_usd: Decimal
    readback: str  # spoken-friendly; the host reads this verbatim
    expires_at: datetime
    simulated: bool


class BlockedResponse(BaseModel):
    blocked: Literal[True] = True
    reason_code: ReasonCode
    spoken_reason: str
    simulated: bool


class ConfirmRequest(BaseModel):
    """Optional echo of what the user believes they are confirming.
    If any field is sent and differs from the intent, confirm is rejected (INTENT_MISMATCH)."""
    kind: Optional[Kind] = None
    symbol: Optional[str] = None
    usd_amount: Optional[Decimal] = None


class ConfirmResponse(BaseModel):
    intent_id: str
    kind: Kind
    symbol: str
    usd_amount: Decimal
    order_id: Optional[str] = None      # buy / sell
    transfer_id: Optional[str] = None   # tip
    status: OrderStatus
    say: str
    simulated: bool


class OrderStatusResponse(BaseModel):
    order_id: str
    status: OrderStatus
    filled_qty: Optional[Decimal] = None
    avg_price_usd: Optional[Decimal] = None
    fee_usd: Optional[Decimal] = None
    simulated: bool


# ---------- board / calls panel ----------
class BoardEvent(BaseModel):
    intent_id: str
    ts: datetime
    first_name: str
    kind: Kind
    symbol: str
    usd_amount: Decimal
    status: OrderStatus
    simulated: bool


class BoardResponse(BaseModel):
    events: list[BoardEvent]


class GatewayCall(BaseModel):
    ts: datetime
    op: str
    ref_id: Optional[str] = None  # order / transfer id when there is one
    status: Literal["ok", "error"]
    latency_ms: int
    error: Optional[str] = None  # error class only, never payloads or keys
    simulated: bool


class CallsResponse(BaseModel):
    calls: list[GatewayCall]


# ---------- show engine (P3) ----------
class ShowLine(BaseModel):
    speaker: Literal["A", "B"]
    line: str = Field(min_length=1, max_length=400)


class GrokScript(BaseModel):
    """Exact JSON Grok must return for one segment."""
    segment_title: str
    lines: list[ShowLine] = Field(min_length=2)
    assets_mentioned: list[str] = []
    big_movers: list[str] = []


class ShowSegment(BaseModel):
    segment_id: str
    audio_url: Optional[str] = None
    started_at: datetime
    duration_s: float
    assets_mentioned: list[str]
    transcript: list[ShowLine]
    is_replay: bool
    simulated: bool


# ---------- call-in agent (P2) ----------
class AgentSessionResponse(BaseModel):
    agent_id: Optional[str]
    signed_url: Optional[str]
    dynamic_vars: dict[str, str]


class AgentQuoteBody(BaseModel):
    user_id: str
    symbol: str
    side: Side
    usd_amount: Decimal


class AgentOrderBody(BaseModel):
    user_id: str
    symbol: str
    usd_amount: Decimal


class AgentConfirmBody(BaseModel):
    user_id: str
    intent_id: str


class AgentToolResponse(BaseModel):
    ok: bool
    say: str  # what the host should say next
    intent_id: Optional[str] = None
    order_id: Optional[str] = None
    transfer_id: Optional[str] = None
    status: Optional[OrderStatus] = None
    reason_code: Optional[ReasonCode] = None
    simulated: bool

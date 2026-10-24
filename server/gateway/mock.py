"""MOCK_MODE backend: realistic fake prices, balances and orders.

Every ID starts with "sim-" and every response is marked simulated=True upstream.
"""
from __future__ import annotations

import math
import secrets
import time
from datetime import datetime, timedelta, timezone
from decimal import ROUND_DOWN, Decimal

from ..allowlist import ASSETS, QUOTE_SYMBOL
from .base import GatewayError, OrderResult, PriceSnap, Quote, TransferResult, UserRef, WalletInfo

STATION = "station"
FILL_DELAY_S = 1.5
QTY_Q = Decimal("0.00000001")
USD_Q = Decimal("0.0001")

# Fixed 24h moves so the show has something to talk about (BTC > 2% triggers the pit bell).
_CHANGE_24H = {"BTC": Decimal("2.4"), "ETH": Decimal("-1.1"), "SOL": Decimal("3.2"),
               "NVDA": Decimal("0.6"), "TSLA": Decimal("-2.7")}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _id(prefix: str) -> str:
    return f"sim-{prefix}-{secrets.token_hex(4)}"


class MockGateway:
    simulated = True

    def __init__(self, fee_bps: int = 20):
        self.fee = Decimal(fee_bps) / Decimal(10000)
        self.balances: dict[str, dict[str, Decimal]] = {
            STATION: {QUOTE_SYMBOL: Decimal("50")},
        }
        self.orders: dict[str, tuple[float, OrderResult]] = {}
        self.transfers: dict[str, TransferResult] = {}

    # ----- market data -----
    def _price(self, symbol: str, t: float | None = None) -> Decimal:
        t = time.time() if t is None else t
        base = ASSETS[symbol].mock_price
        phase = (sum(map(ord, symbol)) % 17) / 3
        wiggle = 0.004 * math.sin(t / 90 + phase) + 0.002 * math.sin(t / 13 + phase * 2)
        return (base * Decimal(1 + wiggle)).quantize(Decimal("0.01"))

    async def get_prices(self, symbols):
        out = {}
        for s in symbols:
            if s in ASSETS:
                out[s] = PriceSnap(s, self._price(s), _CHANGE_24H.get(s), _now())
        return out

    async def get_price_history(self, symbol, range_):
        if symbol not in ASSETS:
            raise GatewayError("unknown asset")
        span = {"1h": 3600, "1d": 86400, "1w": 604800}.get(range_, 86400)
        n = 48
        now = time.time()
        pct = float(_CHANGE_24H.get(symbol, 0)) / 100 * (span / 86400)
        pts = []
        for i in range(n + 1):
            t = now - span + span * i / n
            drift = 1 - pct * (1 - i / n)  # end at today's price
            p = (self._price(symbol, t) * Decimal(drift)).quantize(Decimal("0.01"))
            pts.append((datetime.fromtimestamp(t, timezone.utc), p))
        return pts

    # ----- wallets -----
    async def create_wallets(self, user_id):
        ref = f"sim-user-{user_id}"
        self.balances.setdefault(ref, {QUOTE_SYMBOL: Decimal("0")})
        return ref, [
            WalletInfo("solana", "SIM" + secrets.token_hex(16)),
            WalletInfo("base", "0xSIM" + secrets.token_hex(18)),
        ]

    def _bal(self, ref: str) -> dict[str, Decimal]:
        if ref not in self.balances:
            raise GatewayError("unknown wallet")
        return self.balances[ref]

    async def get_balances(self, user: UserRef):
        return dict(self._bal(user.gateway_ref or STATION))

    # ----- trading -----
    async def get_quote(self, user, symbol, side, usd_amount):
        if symbol not in ASSETS:
            raise GatewayError("unknown asset")
        price = self._price(symbol)
        usd = Decimal(usd_amount)
        fee = (usd * self.fee).quantize(USD_Q)
        qty = (usd / price).quantize(QTY_Q, rounding=ROUND_DOWN)
        total = usd + fee if side == "buy" else usd - fee
        return Quote(symbol, side, usd, qty, price, fee, total, quote_ref=_id("q"))

    async def place_order(self, user, quote, client_ref):
        bal = self._bal(user.gateway_ref)
        if quote.side == "buy":
            if bal.get(QUOTE_SYMBOL, Decimal(0)) < quote.total_usd:
                raise GatewayError("insufficient USDC")
            bal[QUOTE_SYMBOL] -= quote.total_usd
            bal[quote.symbol] = bal.get(quote.symbol, Decimal(0)) + quote.qty
        else:
            if bal.get(quote.symbol, Decimal(0)) < quote.qty:
                raise GatewayError("insufficient asset")
            bal[quote.symbol] -= quote.qty
            bal[QUOTE_SYMBOL] = bal.get(QUOTE_SYMBOL, Decimal(0)) + quote.total_usd
        oid = _id("ord")
        res = OrderResult(oid, "filled", quote.qty, quote.price_usd, quote.fee_usd)
        self.orders[oid] = (time.time(), res)
        return OrderResult(oid, "pending")

    async def get_order_status(self, user, order_id):
        if order_id not in self.orders:
            raise GatewayError("unknown order")
        created, final = self.orders[order_id]
        if time.time() - created < FILL_DELAY_S:
            return OrderResult(order_id, "pending")
        return final

    # ----- payments -----
    def _move(self, src: str, dst: str, symbol: str, qty: Decimal) -> TransferResult:
        s, d = self._bal(src), self._bal(dst)
        if s.get(symbol, Decimal(0)) < qty:
            raise GatewayError("insufficient balance")
        s[symbol] -= qty
        d[symbol] = d.get(symbol, Decimal(0)) + qty
        tr = TransferResult(_id("tr"), "filled")
        self.transfers[tr.transfer_id] = tr
        return tr

    async def transfer_to_station(self, user, symbol, qty, client_ref):
        return self._move(user.gateway_ref, STATION, symbol, qty)

    async def fund_from_station(self, user, symbol, qty, client_ref):
        return self._move(STATION, user.gateway_ref, symbol, qty)

    async def get_transfer_status(self, user, transfer_id):
        if transfer_id not in self.transfers:
            raise GatewayError("unknown transfer")
        return self.transfers[transfer_id]

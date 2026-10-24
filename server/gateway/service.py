"""Gateway service: the only code that talks to a backend. Every call is logged."""
from __future__ import annotations

import time
from datetime import datetime, timezone
from decimal import Decimal

from ..allowlist import QUOTE_SYMBOL
from ..board import CallLog
from ..contract import GatewayCall
from .base import GatewayBackend, GatewayError, PriceSnap, UserRef


class GatewayService:
    def __init__(self, backend: GatewayBackend, calls: CallLog, price_cache_s: int = 5):
        self.backend = backend
        self.calls = calls
        self.simulated = backend.simulated
        self.price_cache_s = price_cache_s
        self._price_cache: tuple[float, dict[str, PriceSnap]] | None = None

    async def _call(self, op: str, coro, ref_of=None):
        t0 = time.perf_counter()
        status, err, ref, result = "ok", None, None, None
        try:
            result = await coro
            ref = ref_of(result) if ref_of and result is not None else None
            return result
        except Exception as e:  # logged, then re-raised
            status, err = "error", type(e).__name__
            ref = getattr(e, "ref_id", None)
            raise
        finally:
            self.calls.add(GatewayCall(
                ts=datetime.now(timezone.utc), op=op, ref_id=ref, status=status,
                latency_ms=int((time.perf_counter() - t0) * 1000), error=err,
                simulated=self.simulated,
            ))

    # ----- wallets -----
    async def create_wallets(self, user_id: str):
        return await self._call("create_wallets", self.backend.create_wallets(user_id))

    async def get_balance(self, user: UserRef) -> dict[str, Decimal]:
        return await self._call("get_balances", self.backend.get_balances(user))

    async def fund_wallet(self, user: UserRef, usd_amount: Decimal, client_ref: str):
        # USDC is treated as 1:1 USD for funding.
        return await self._call("fund_wallet",
                                self.backend.fund_from_station(user, QUOTE_SYMBOL, usd_amount, client_ref),
                                lambda r: r.transfer_id)

    # ----- market data -----
    async def get_prices(self, symbols: list[str]) -> dict[str, PriceSnap]:
        """Cached for a few seconds so many listeners don't flood the Gateway."""
        now = time.monotonic()
        if self._price_cache and now - self._price_cache[0] < self.price_cache_s:
            cached = self._price_cache[1]
            if all(s in cached for s in symbols):
                return {s: cached[s] for s in symbols}
        prices = await self._call("get_prices", self.backend.get_prices(symbols))
        merged = dict(self._price_cache[1]) if self._price_cache else {}
        merged.update(prices)
        self._price_cache = (now, merged)
        return prices

    async def get_price_history(self, symbol: str, range_: str):
        return await self._call("get_price_history", self.backend.get_price_history(symbol, range_))

    # ----- trading -----
    async def get_quote(self, user: UserRef, symbol: str, side: str, usd_amount: Decimal):
        return await self._call("get_quote", self.backend.get_quote(user, symbol, side, usd_amount))

    async def buy(self, user: UserRef, quote, client_ref: str):
        if quote.side != "buy":
            raise GatewayError("quote side mismatch")
        return await self._call("buy", self.backend.place_order(user, quote, client_ref), lambda r: r.order_id)

    async def sell(self, user: UserRef, quote, client_ref: str):
        if quote.side != "sell":
            raise GatewayError("quote side mismatch")
        return await self._call("sell", self.backend.place_order(user, quote, client_ref), lambda r: r.order_id)

    async def get_order_status(self, user: UserRef, order_id: str):
        return await self._call("get_order_status", self.backend.get_order_status(user, order_id),
                                lambda r: r.order_id)

    # ----- payments -----
    async def tip_host(self, user: UserRef, symbol: str, qty: Decimal, client_ref: str):
        return await self._call("tip_host", self.backend.transfer_to_station(user, symbol, qty, client_ref),
                                lambda r: r.transfer_id)

    async def get_transfer_status(self, user: UserRef, transfer_id: str):
        return await self._call("get_transfer_status", self.backend.get_transfer_status(user, transfer_id),
                                lambda r: r.transfer_id)

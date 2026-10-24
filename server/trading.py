"""Intent -> confirm orchestration shared by every channel (screen, one-tap, call, push-to-talk)."""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from decimal import ROUND_DOWN, Decimal

from .allowlist import ASSETS, QUOTE_SYMBOL, tradable_symbols
from .board import Board
from .config import Settings
from .contract import BlockedResponse, BoardEvent, ConfirmResponse, IntentResponse
from .gateway.base import GatewayError, GatewayUncertain
from .gateway.service import GatewayService
from .policy.intents import IntentError, IntentStore
from .policy.rules import Limits, evaluate_data, evaluate_static
from .spoken import money_words, price_words
from .users import LedgerEntry, User

QTY_Q = Decimal("0.00000001")
POLL_EVERY_S = 1.5
POLL_MAX = 40


class TradeBlocked(Exception):
    def __init__(self, code: str, spoken: str):
        super().__init__(code)
        self.code, self.spoken = code, spoken


class Trading:
    def __init__(self, settings: Settings, gw: GatewayService, intents: IntentStore, board: Board):
        self.s = settings
        self.gw = gw
        self.intents = intents
        self.board = board
        self.limits = Limits(settings.max_order_usd, settings.max_daily_usd)

    @property
    def sim(self) -> bool:
        return self.gw.simulated

    def _blocked(self, code, spoken) -> BlockedResponse:
        return BlockedResponse(reason_code=code, spoken_reason=spoken, simulated=self.sim)

    # ---------------- intent ----------------
    async def create_intent(self, user: User, kind: str, symbol: str, usd_amount) -> IntentResponse | BlockedResponse:
        symbol = (symbol or "").strip().upper()
        d = evaluate_static(kind, symbol, usd_amount, user.daily_used(), self.limits,
                            tradable_symbols(self.s.mock_mode))
        if not d.allowed:  # never touches the Gateway
            return self._blocked(d.reason_code, d.spoken_reason)
        amt = Decimal(usd_amount)

        price = age = None
        try:
            snap = (await self.gw.get_prices([symbol])).get(symbol)
            if snap:
                price = snap.price_usd
                age = (datetime.now(timezone.utc) - snap.as_of).total_seconds()
        except Exception:
            pass

        try:
            balances = await self.gw.get_balance(user.ref)
        except Exception:
            balances = None

        quote, balance_ok = None, None
        if price is not None and balances is not None:
            try:
                if kind in ("buy", "sell"):
                    quote = await self.gw.get_quote(user.ref, symbol, kind, amt)
                    if kind == "buy":
                        balance_ok = balances.get(QUOTE_SYMBOL, Decimal(0)) >= quote.total_usd
                    else:
                        balance_ok = balances.get(symbol, Decimal(0)) >= quote.qty
                else:  # tip: pay the station in the asset itself
                    qty = (amt / price).quantize(QTY_Q, rounding=ROUND_DOWN)
                    balance_ok = qty > 0 and balances.get(symbol, Decimal(0)) >= qty
            except Exception:
                price = None  # quote failed -> fail closed

        d = evaluate_data(price, age, self.s.price_max_age_s, balance_ok)
        if not d.allowed:
            return self._blocked(d.reason_code, d.spoken_reason)

        if quote is not None:
            est_qty, px, fee, total = quote.qty, quote.price_usd, quote.fee_usd, quote.total_usd
            payload = quote
        else:
            est_qty = (amt / price).quantize(QTY_Q, rounding=ROUND_DOWN)
            px, fee, total = price, Decimal(0), amt  # transfer fee unknown until verified
            payload = {"qty": est_qty, "price": price}

        it = self.intents.create(user.user_id, kind, symbol, amt, payload)
        return IntentResponse(
            intent_id=it.intent_id, kind=kind, symbol=symbol, usd_amount=amt, est_qty=est_qty,
            price_usd=px, fee_usd=fee, total_usd=total,
            readback=self._readback(user, kind, symbol, amt, px, fee, total),
            expires_at=datetime.fromtimestamp(it.expires_at, timezone.utc), simulated=self.sim,
        )

    def _readback(self, user, kind, symbol, amt, px, fee, total) -> str:
        name = ASSETS[symbol].spoken_name
        if kind == "buy":
            core = (f"{user.first_name}, here's your order: buy {money_words(amt)} of {name} "
                    f"at about {price_words(px)}. The fee is {money_words(fee)}, "
                    f"so the total is {money_words(total)}.")
        elif kind == "sell":
            core = (f"{user.first_name}, here's your order: sell {money_words(amt)} of {name} "
                    f"at about {price_words(px)}. The fee is {money_words(fee)}, "
                    f"so you get about {money_words(total)}.")
        else:
            core = f"{user.first_name}, you're tipping the hosts {money_words(amt)} of {name}."
        sim = " This is a simulated order." if self.sim else ""
        return f"{core}{sim} Say confirm to send it."

    # ---------------- confirm ----------------
    async def confirm(self, user: User, intent_id: str, kind=None, symbol=None, usd_amount=None) -> ConfirmResponse:
        async with user.lock:
            try:
                it = self.intents.consume(intent_id, user.user_id, kind, symbol, usd_amount)
            except IntentError as e:
                raise TradeBlocked(e.code, e.spoken)

            # Re-check caps at execution time (other orders may have landed since the read-back).
            d = evaluate_static(it.kind, it.symbol, it.usd_amount, user.daily_used(), self.limits,
                                tradable_symbols(self.s.mock_mode))
            if not d.allowed:
                raise TradeBlocked(d.reason_code, d.spoken_reason)

            entry = LedgerEntry(it.intent_id, it.kind, it.symbol, it.usd_amount, "pending", time.time())
            user.ledger.append(entry)  # counts toward the daily cap before we call out
            try:
                if it.kind == "buy":
                    res = await self.gw.buy(user.ref, it.payload, it.intent_id)
                    entry.ref_id, entry.status = res.order_id, res.status
                elif it.kind == "sell":
                    res = await self.gw.sell(user.ref, it.payload, it.intent_id)
                    entry.ref_id, entry.status = res.order_id, res.status
                else:
                    res = await self.gw.tip_host(user.ref, it.symbol, it.payload["qty"], it.intent_id)
                    entry.ref_id, entry.status = res.transfer_id, res.status
            except GatewayUncertain as e:
                entry.ref_id, entry.status = e.ref_id, "unknown"  # query status; never resubmit
            except GatewayError:
                entry.status = "failed"

        self._post_board(user, entry)
        if entry.status in ("pending", "unknown") and entry.ref_id:
            asyncio.create_task(self._poll(user, entry))

        is_tip = it.kind == "tip"
        return ConfirmResponse(
            intent_id=it.intent_id, kind=it.kind, symbol=it.symbol, usd_amount=it.usd_amount,
            order_id=None if is_tip else entry.ref_id, transfer_id=entry.ref_id if is_tip else None,
            status=entry.status, say=self._say(user, entry), simulated=self.sim,
        )

    def _say(self, user: User, e: LedgerEntry) -> str:
        name, amt = ASSETS[e.symbol].spoken_name, money_words(e.usd_amount)
        sim = "Simulated. " if self.sim else ""
        if e.status == "failed":
            return "The exchange didn't take that one. Nothing was sent."
        if e.status == "unknown":
            return "I'm checking on that order with the exchange. Don't send it again, I'll update the board."
        if e.kind == "tip":
            return f"{sim}Tip sent. Thank you, {user.first_name}!"
        verb = "bought" if e.kind == "buy" else "sold"
        done = "Done" if e.status == "filled" else "It's on the floor"
        return f"{sim}{done}: {verb} {amt} of {name}. Watch the board, {user.first_name}."

    def _post_board(self, user: User, e: LedgerEntry):
        self.board.upsert(BoardEvent(
            intent_id=e.intent_id, ts=datetime.fromtimestamp(e.created_at, timezone.utc),
            first_name=user.first_name, kind=e.kind, symbol=e.symbol, usd_amount=e.usd_amount,
            status=e.status, simulated=self.sim,
        ))

    async def _poll(self, user: User, e: LedgerEntry):
        for _ in range(POLL_MAX):
            await asyncio.sleep(POLL_EVERY_S)
            try:
                if e.kind == "tip":
                    r = await self.gw.get_transfer_status(user.ref, e.ref_id)
                else:
                    r = await self.gw.get_order_status(user.ref, e.ref_id)
            except Exception:
                continue  # stays pending/unknown and keeps counting toward the cap
            if r.status != e.status:
                e.status = r.status
                self._post_board(user, e)
            if r.status in ("filled", "failed"):
                return

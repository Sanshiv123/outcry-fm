"""Deterministic policy. Pure functions — no I/O, no LLM.

Order of checks matters: static checks run BEFORE any Gateway call, so a blocked
order (e.g. $500) never reaches the Gateway.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from ..allowlist import spoken_list
from ..spoken import money_words


@dataclass(frozen=True)
class Limits:
    max_order_usd: Decimal
    max_daily_usd: Decimal


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reason_code: str | None = None
    spoken_reason: str | None = None


ALLOW = Decision(True)


def _block(code: str, spoken: str) -> Decision:
    return Decision(False, code, spoken)


def evaluate_static(kind: str, symbol: str, usd_amount, daily_used_usd: Decimal,
                    limits: Limits, tradable: set[str]) -> Decision:
    try:
        amt = Decimal(usd_amount)
    except (InvalidOperation, TypeError, ValueError):
        amt = None
    if amt is None or not amt.is_finite() or amt <= 0 or amt != amt.quantize(Decimal("0.01")):
        return _block("BAD_AMOUNT", "Give me a dollar amount above zero, in dollars and cents.")
    if kind not in {"buy", "sell", "tip"}:
        return _block("NOT_ALLOWED", "The floor only takes buys, sells and tips.")
    if symbol not in tradable:
        return _block("NOT_ALLOWED",
                      f"That one isn't on the board today. The floor trades {spoken_list(tradable)}.")
    if amt > limits.max_order_usd:
        return _block("MAX_ORDER",
                      f"The floor won't allow orders over {money_words(limits.max_order_usd)}.")
    if daily_used_usd + amt > limits.max_daily_usd:
        left = max(limits.max_daily_usd - daily_used_usd, Decimal(0))
        tail = (f"You have {money_words(left)} left today." if left > 0
                else "You've hit today's limit.")
        return _block("DAILY_CAP",
                      f"That would go over the daily limit of {money_words(limits.max_daily_usd)}. {tail}")
    return ALLOW


def evaluate_data(price_usd: Decimal | None, price_age_s: float | None, max_age_s: int,
                  balance_ok: bool | None) -> Decision:
    """Missing or stale data fails closed."""
    if price_usd is None or price_usd <= 0 or price_age_s is None or price_age_s > max_age_s:
        return _block("NO_PRICE", "I can't get a clean price on that right now, so the floor is holding the order.")
    if balance_ok is not True:
        return _block("NO_BALANCE", "There isn't enough in your wallet for that one.")
    return ALLOW

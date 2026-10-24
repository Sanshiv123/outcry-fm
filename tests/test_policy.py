from decimal import Decimal as D

import pytest

from server.policy.intents import IntentError, IntentStore
from server.policy.rules import Limits, evaluate_data, evaluate_static

LIM = Limits(max_order_usd=D("5"), max_daily_usd=D("20"))
TRADABLE = {"BTC", "ETH"}


# ----- caps -----
def test_max_order_cap():
    assert evaluate_static("buy", "BTC", D("5"), D("0"), LIM, TRADABLE).allowed
    d = evaluate_static("buy", "BTC", D("500"), D("0"), LIM, TRADABLE)
    assert not d.allowed and d.reason_code == "MAX_ORDER"
    assert "five dollars" in d.spoken_reason


def test_daily_cap_counts_used_and_pending():
    assert evaluate_static("buy", "BTC", D("4"), D("16"), LIM, TRADABLE).allowed
    d = evaluate_static("buy", "BTC", D("4.01"), D("16"), LIM, TRADABLE)
    assert not d.allowed and d.reason_code == "DAILY_CAP"


# ----- expiry -----
def test_intent_expires_after_ttl():
    now = [1000.0]
    store = IntentStore(ttl_s=30, clock=lambda: now[0])
    it = store.create("u1", "buy", "BTC", D("1"))
    now[0] += 31
    with pytest.raises(IntentError) as e:
        store.consume(it.intent_id, "u1")
    assert e.value.code == "INTENT_EXPIRED"


def test_intent_invalid_after_change_and_single_use():
    store = IntentStore(ttl_s=30, clock=lambda: 0.0)
    old = store.create("u1", "buy", "BTC", D("1"))
    new = store.create("u1", "buy", "BTC", D("2"))  # amount changed -> old superseded
    with pytest.raises(IntentError) as e:
        store.consume(old.intent_id, "u1")
    assert e.value.code == "INTENT_MISMATCH"
    store.consume(new.intent_id, "u1")
    with pytest.raises(IntentError) as e:
        store.consume(new.intent_id, "u1")
    assert e.value.code == "INTENT_USED"


# ----- blocked orders -----
@pytest.mark.parametrize("kind,symbol,amt,code", [
    ("buy", "DOGE", D("1"), "NOT_ALLOWED"),
    ("buy", "BTC", D("0"), "BAD_AMOUNT"),
    ("buy", "BTC", D("1.001"), "BAD_AMOUNT"),
])
def test_blocked_static(kind, symbol, amt, code):
    d = evaluate_static(kind, symbol, amt, D("0"), LIM, TRADABLE)
    assert not d.allowed and d.reason_code == code and d.spoken_reason


def test_missing_data_fails_closed():
    assert evaluate_data(None, 1, 60, True).reason_code == "NO_PRICE"
    assert evaluate_data(D("100"), 120, 60, True).reason_code == "NO_PRICE"
    assert evaluate_data(D("100"), 1, 60, None).reason_code == "NO_BALANCE"
    assert evaluate_data(D("100"), 1, 60, True).allowed

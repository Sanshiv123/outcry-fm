"""OUTCRY.FM backend. Run: uvicorn server.app:app --reload --port 8000"""
from __future__ import annotations

import asyncio
import secrets
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import Depends, FastAPI, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from .allowlist import ASSETS, QUOTE_SYMBOL, tradable_symbols
from .board import Board, CallLog, EventBus
from .config import settings
from .contract import (
    AgentConfirmBody, AgentOrderBody, AgentQuoteBody, AgentSessionResponse, AgentToolResponse,
    AssetPrice, Balance, BlockedResponse, BoardResponse, CallsResponse, ConfirmRequest, ConfirmResponse,
    ErrorResponse, HistoryResponse, IntentRequest, IntentResponse, MeResponse, OrderStatusResponse,
    PricePoint, PricesResponse, ShowLine, ShowSegment, SignupRequest, SignupResponse, Wallet,
)
from .gateway.base import GatewayError, GatewayUncertain
from .gateway.mock import MockGateway
from .gateway.service import GatewayService
from .gateway.truemarkets import TrueMarketsGateway
from .policy.intents import IntentStore
from .spoken import int_words, price_words
from .trading import TradeBlocked, Trading
from .users import User, UserStore

# ---------- wiring ----------
bus = EventBus()
board = Board(bus)
calls = CallLog(bus)
backend = (MockGateway(settings.fee_bps) if settings.mock_mode
           else TrueMarketsGateway(settings.wallet_model, settings.station_wallet_address))
gw = GatewayService(backend, calls, settings.price_cache_s)
intents = IntentStore(ttl_s=settings.intent_ttl_s)
users = UserStore()
trading = Trading(settings, gw, intents, board)

app = FastAPI(title="OUTCRY.FM")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def err(status: int, code: str, spoken: str, error: str | None = None) -> JSONResponse:
    body = ErrorResponse(error=error or code.lower(), reason_code=code, spoken_reason=spoken)
    return JSONResponse(status_code=status, content=body.model_dump(mode="json"))


class _Unauthorized(Exception):
    pass


@app.exception_handler(_Unauthorized)
async def _unauth(_: Request, __: _Unauthorized):
    return err(401, "UNAUTHORIZED", "You need to sign up first.")


def current_user(authorization: str | None = Header(default=None)) -> User:
    token = (authorization or "").removeprefix("Bearer ").strip()
    user = users.by_session.get(token)
    if not user:
        raise _Unauthorized()
    return user


def agent_auth(x_agent_secret: str | None = Header(default=None)):
    if settings.agent_tool_secret:
        if not x_agent_secret or not secrets.compare_digest(x_agent_secret, settings.agent_tool_secret):
            raise _Unauthorized()
    elif not settings.mock_mode:
        raise _Unauthorized()  # real money: secret is mandatory


# ---------- health ----------
@app.get("/api/health")
async def health():
    return {"ok": True, "mock_mode": settings.mock_mode, "wallet_model": settings.wallet_model,
            "tradable": sorted(tradable_symbols(settings.mock_mode))}


# ---------- signup / me ----------
@app.post("/api/signup", response_model=SignupResponse)
async def signup(req: SignupRequest):
    user_id, session = users.new_ids()
    try:
        ref, wallets = await gw.create_wallets(user_id)
    except (GatewayError, NotImplementedError):
        return err(502, "GATEWAY_ERROR", "Couldn't open a wallet right now. Try again in a moment.")
    user = User(user_id, req.first_name.strip(), req.email.strip(), session, ref, wallets)
    users.add(user)

    funded, transfer_id = False, None
    if users.funded_count < settings.max_funded_wallets:
        users.funded_count += 1  # reserve the slot before calling out
        try:
            tr = await gw.fund_wallet(user.ref, settings.fund_amount_usd, f"fund-{user_id}")
            funded, transfer_id = True, tr.transfer_id
        except GatewayUncertain as e:
            transfer_id = e.ref_id  # keep the slot; check status manually, never resend
        except (GatewayError, NotImplementedError):
            users.funded_count -= 1

    return SignupResponse(user_id=user_id, first_name=user.first_name,
                          wallets=[Wallet(chain=w.chain, address=w.address) for w in wallets],
                          session=session, funded=funded, funding_transfer_id=transfer_id,
                          simulated=gw.simulated)


@app.get("/api/me", response_model=MeResponse)
async def me(user: User = Depends(current_user)):
    try:
        bals = await gw.get_balance(user.ref)
    except (GatewayError, NotImplementedError):
        bals = {}
    try:
        prices = await gw.get_prices([s for s in bals if s in ASSETS])
    except (GatewayError, NotImplementedError):
        prices = {}
    out = []
    for sym, qty in bals.items():
        if sym == QUOTE_SYMBOL:
            usd = qty
        else:
            usd = (qty * prices[sym].price_usd).quantize(Decimal("0.01")) if sym in prices else None
        out.append(Balance(symbol=sym, qty=qty, usd_value=usd))
    return MeResponse(user_id=user.user_id, first_name=user.first_name,
                      wallets=[Wallet(chain=w.chain, address=w.address) for w in user.wallets],
                      balances=out, daily_used_usd=user.daily_used(),
                      daily_cap_usd=settings.max_daily_usd, max_order_usd=settings.max_order_usd,
                      simulated=gw.simulated)


# ---------- market data ----------
@app.get("/api/market/prices", response_model=PricesResponse)
async def market_prices():
    syms = sorted(tradable_symbols(settings.mock_mode))
    try:
        snaps = await gw.get_prices(syms)
    except (GatewayError, NotImplementedError):
        return err(502, "NO_PRICE", "Prices are unavailable right now.")
    assets = [AssetPrice(symbol=s, name=ASSETS[s].name, spoken_name=ASSETS[s].spoken_name,
                         price_usd=snaps[s].price_usd, change_24h_pct=snaps[s].change_24h_pct)
              for s in syms if s in snaps]
    as_of = min((snaps[s].as_of for s in snaps), default=datetime.now(timezone.utc))
    return PricesResponse(as_of=as_of, assets=assets, simulated=gw.simulated)


@app.get("/api/market/history", response_model=HistoryResponse)
async def market_history(symbol: str, range: str = "1d"):
    symbol = symbol.upper()
    if symbol not in tradable_symbols(settings.mock_mode):
        return err(404, "NOT_ALLOWED", "That asset isn't on the board.")
    try:
        pts = await gw.get_price_history(symbol, range)
    except (GatewayError, NotImplementedError):
        return err(502, "NO_PRICE", "Price history is unavailable right now.")
    return HistoryResponse(symbol=symbol, range=range, simulated=gw.simulated,
                           points=[PricePoint(t=t, price_usd=p) for t, p in pts])


# ---------- intent -> confirm ----------
@app.post("/api/intents", response_model=IntentResponse | BlockedResponse)
async def create_intent(req: IntentRequest, user: User = Depends(current_user)):
    return await trading.create_intent(user, req.kind, req.symbol, req.usd_amount)


@app.post("/api/intents/{intent_id}/confirm", response_model=ConfirmResponse)
async def confirm_intent(intent_id: str, req: ConfirmRequest | None = None, user: User = Depends(current_user)):
    req = req or ConfirmRequest()
    try:
        return await trading.confirm(user, intent_id, req.kind, req.symbol, req.usd_amount)
    except TradeBlocked as e:
        return err(409, e.code, e.spoken)


@app.get("/api/orders/{order_id}", response_model=OrderStatusResponse)
async def order_status(order_id: str, user: User = Depends(current_user)):
    if not any(e.ref_id == order_id for e in user.ledger):
        return err(404, "NOT_FOUND", "I can't find that order.")
    try:
        r = await gw.get_order_status(user.ref, order_id)
    except (GatewayError, NotImplementedError):
        return err(502, "GATEWAY_ERROR", "Couldn't reach the exchange for that order.")
    return OrderStatusResponse(order_id=r.order_id, status=r.status, filled_qty=r.filled_qty,
                               avg_price_usd=r.avg_price_usd, fee_usd=r.fee_usd, simulated=gw.simulated)


# ---------- board / calls / stream ----------
@app.get("/api/board", response_model=BoardResponse)
async def get_board():
    return BoardResponse(events=board.recent())


@app.get("/api/calls", response_model=CallsResponse)
async def get_calls():
    return CallsResponse(calls=calls.recent())


@app.get("/api/stream")
async def stream(request: Request):
    q = bus.subscribe()

    async def gen():
        try:
            yield ": connected\n\n"
            while not await request.is_disconnected():
                try:
                    yield await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            bus.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------- show (P3 replaces this stub) ----------
_SHOW_START = datetime.now(timezone.utc)


@app.get("/api/show/current", response_model=ShowSegment)
async def show_current():
    """STUB for P4 until P3's queue lands: text-only segment built from mock prices."""
    return ShowSegment(
        segment_id="stub-0", audio_url=None, started_at=_SHOW_START, duration_s=75,
        assets_mentioned=["BTC", "SOL"], is_replay=False, simulated=True,
        transcript=[ShowLine(speaker="A", line="Good morning pit, this is OUTCRY dot F M."),
                    ShowLine(speaker="B", line="Bitcoin is up about two percent today, and Solana is moving too.")],
    )


# ---------- call-in agent tools (P2 wires ElevenLabs to these) ----------
def _pct_words(p: Decimal) -> str:
    p = abs(p).quantize(Decimal("0.1"))
    whole, tenth = int(p), int((p - int(p)) * 10)
    return f"{int_words(whole)}" + (f" point {int_words(tenth)}" if tenth else "") + " percent"


def _agent_user(user_id: str) -> User:
    u = users.by_id.get(user_id)
    if not u:
        raise _Unauthorized()
    return u


def _intent_to_tool(r) -> AgentToolResponse:
    if r.blocked:
        return AgentToolResponse(ok=False, say=r.spoken_reason, reason_code=r.reason_code, simulated=r.simulated)
    return AgentToolResponse(ok=True, say=r.readback, intent_id=r.intent_id, simulated=r.simulated)


@app.get("/api/agent/session", response_model=AgentSessionResponse)
async def agent_session(user: User = Depends(current_user)):
    # P2: fetch a signed URL from ElevenLabs here (verify the exact API in their docs).
    return AgentSessionResponse(agent_id=settings.elevenlabs_agent_id, signed_url=None,
                                dynamic_vars={"user_id": user.user_id, "first_name": user.first_name})


@app.post("/api/agent/tools/get_quote", response_model=AgentToolResponse, dependencies=[Depends(agent_auth)])
async def tool_get_quote(body: AgentQuoteBody):
    _agent_user(body.user_id)
    sym = body.symbol.upper()
    if sym not in tradable_symbols(settings.mock_mode):
        return AgentToolResponse(ok=False, say="That one isn't on the board today.", reason_code="NOT_ALLOWED",
                                 simulated=gw.simulated)
    try:
        snap = (await gw.get_prices([sym]))[sym]
    except Exception:
        return AgentToolResponse(ok=False, say="I can't get a clean price on that right now.",
                                 reason_code="NO_PRICE", simulated=gw.simulated)
    say = f"{ASSETS[sym].spoken_name} is at about {price_words(snap.price_usd)}"
    if snap.change_24h_pct is not None:
        say += f", {'up' if snap.change_24h_pct >= 0 else 'down'} {_pct_words(snap.change_24h_pct)} today"
    return AgentToolResponse(ok=True, say=say + ".", simulated=gw.simulated)


@app.post("/api/agent/tools/buy", response_model=AgentToolResponse, dependencies=[Depends(agent_auth)])
async def tool_buy(body: AgentOrderBody):
    return _intent_to_tool(await trading.create_intent(_agent_user(body.user_id), "buy", body.symbol, body.usd_amount))


@app.post("/api/agent/tools/sell", response_model=AgentToolResponse, dependencies=[Depends(agent_auth)])
async def tool_sell(body: AgentOrderBody):
    return _intent_to_tool(await trading.create_intent(_agent_user(body.user_id), "sell", body.symbol, body.usd_amount))


@app.post("/api/agent/tools/tip_host", response_model=AgentToolResponse, dependencies=[Depends(agent_auth)])
async def tool_tip(body: AgentOrderBody):
    return _intent_to_tool(await trading.create_intent(_agent_user(body.user_id), "tip", body.symbol, body.usd_amount))


@app.post("/api/agent/tools/confirm", response_model=AgentToolResponse, dependencies=[Depends(agent_auth)])
async def tool_confirm(body: AgentConfirmBody):
    user = _agent_user(body.user_id)
    try:
        r = await trading.confirm(user, body.intent_id)
    except TradeBlocked as e:
        return AgentToolResponse(ok=False, say=e.spoken, reason_code=e.code, simulated=gw.simulated)
    return AgentToolResponse(ok=r.status != "failed", say=r.say, intent_id=r.intent_id, order_id=r.order_id,
                             transfer_id=r.transfer_id, status=r.status, simulated=r.simulated)

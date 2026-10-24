# OUTCRY.FM — API contract (for P1–P4)

Source of truth: `server/contract.py`. Live, clickable docs: `http://localhost:8000/docs`.

## Run on mocks (no keys needed)
```
pip install -r requirements.txt
cp .env.example .env          # MOCK_MODE=true by default
uvicorn server.app:app --reload --port 8000
ngrok http 8000               # phones + ElevenLabs webhooks
pytest -q                     # policy tests
```

## Conventions
- Money is a JSON **string** in responses (`"1.00"`). Requests accept a string or number.
- Every response has `simulated`. If `true`, the UI must show **SIMULATED**. Mock IDs start with `sim-`.
- Auth: `Authorization: Bearer <session>` (from signup). Agent tools use the `X-Agent-Secret` header instead.
- Errors: `{error, reason_code, spoken_reason}`. The host can read `spoken_reason` aloud.

## The one rule: intent → confirm
Every trade and tip (screen, one-tap, call, push-to-talk) runs in two steps:
1. `POST /api/intents` → either a read-back or `blocked:true` with a spoken reason. Blocked orders never reach the Gateway.
2. `POST /api/intents/{id}/confirm` → executes.

An intent is single-use and expires after 30 s. Creating a new intent cancels the previous one.

## Endpoints
| Method | Path | Owner | Notes |
|---|---|---|---|
| GET | `/api/health` | P1 | `{ok, mock_mode, wallet_model, tradable}` |
| POST | `/api/signup` | P1 | `{first_name, email}` → `{user_id, first_name, wallets, session, funded, funding_transfer_id}`. The first 6 signups get $3 from the station wallet. |
| GET | `/api/me` | P1 | balances, `daily_used_usd`, caps |
| GET | `/api/market/prices` | P1 | `{as_of, assets:[{symbol, name, spoken_name, price_usd, change_24h_pct}]}` (cached 5 s) |
| GET | `/api/market/history?symbol=BTC&range=1h\|1d\|1w` | P1 | `{points:[{t, price_usd}]}` |
| POST | `/api/intents` | P1 | `{kind:"buy"\|"sell"\|"tip", symbol, usd_amount, channel}` |
| POST | `/api/intents/{id}/confirm` | P1 | optional `{kind, symbol, usd_amount}` echo; a mismatch rejects with `INTENT_MISMATCH` |
| GET | `/api/orders/{order_id}` | P1 | status |
| GET | `/api/board` | P1 | latest trades/tips; P3 reads this for shout-outs |
| GET | `/api/calls` | P1 | Gateway calls panel |
| GET | `/api/stream` | P1 | SSE events: `board`, `call` (P3 adds `segment`) |
| GET | `/api/show/current` | **P3** | stub now (text only, `audio_url: null`) |
| GET | `/api/agent/session` | **P2** | returns `dynamic_vars {user_id, first_name}`; P2 adds `signed_url` |
| POST | `/api/agent/tools/get_quote` | P2 wires | `{user_id, symbol, side, usd_amount}` |
| POST | `/api/agent/tools/buy`, `/sell`, `/tip_host` | P2 wires | `{user_id, symbol, usd_amount}` → `{ok, say, intent_id?, reason_code?}` |
| POST | `/api/agent/tools/confirm` | P2 wires | `{user_id, intent_id}` → `{ok, say, order_id?, transfer_id?, status}` |

Agent tools always return HTTP 200. The host speaks `say` as-is.

## Reason codes
`MAX_ORDER`, `DAILY_CAP`, `NOT_ALLOWED`, `NO_PRICE`, `NO_BALANCE`, `BAD_AMOUNT`, `INTENT_EXPIRED`, `INTENT_USED`, `INTENT_MISMATCH`, `NOT_FOUND`, `GATEWAY_ERROR`, `UNAUTHORIZED`

## Grok script (P3)
```json
{"segment_title": "...", "lines": [{"speaker": "A", "line": "..."}],
 "assets_mentioned": ["BTC"], "big_movers": ["BTC"]}
```
Validate with `server.show_validate.validate_script(raw)`. It checks allowlist assets only and rejects recommendation language. There is no number matching, so give Grok a rounded price table.

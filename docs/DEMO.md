# Demo recording checklist

Two separate recordings. Do mock first — it is the safe, full-feature walkthrough.
Do live second, and **only attempt the steps marked "live: verified"** — anything
else in live mode will currently fail on camera (see "What live mode cannot do yet"
below) and should not be attempted during a take.

Target length: ~90 seconds for the submission video. A narration script
(`demo-script.txt`) with timed stage directions is at the repo root; a generated
ElevenLabs voiceover (`voiceover.mp3`) can be used as the audio track, or read the
script live while recording. Both are gitignored — regenerate them locally with
your own `ELEVENLABS_API_KEY` if you need a fresh version.

## Part 1 — Mock mode (full feature set, safe)

`MOCK_MODE=true` (the default). `npm run dev`, open `http://localhost:4747`.

1. Station page loads, hosts talking, "SIMULATED MARKET" banner visible.
2. **Sign up** a fresh account. Show the wallet addresses and the mode label.
3. **Voice/typed trade:** "Call the floor" → `buy 1 dollar of SOL`. Show the
   read-back (Gateway-derived amount + fee), then `confirm`. Show the verified
   status and the board updating.
4. **Cap refusal:** call the floor again, try `buy 500 SOL`. Show the backend
   refusing it — the limit is enforced in code, not by the model.
5. **Tip:** `tip 1 dollar of SOL`, confirm, show it land on the board.
6. **Standing order:** `buy 1 dollar of SOL every time it drops below <price just
   above the current one>` → `arm it`. It should fire within a few seconds since
   the condition is already met — show the automatic fill and the on-air
   announcement. Open the "Standing orders" tab to show the armed/filled rule.
7. **Crowd Call:** tap Bull or Bear on the open round (or say "I'm bullish").
   If timing allows, wait for the bell and show the settlement announcement and
   leaderboard.
8. **The Wire:** open it, show the full list of Gateway calls with their IDs.

## Part 2 — Live mode (real True Markets Gateway, real funds)

`MOCK_MODE=false`, pointed at the funded org's API key + station signer key
(ask whoever is holding those locally — never commit them). The "REAL FUNDS"
banner must be visible the whole time this is being recorded.

**Live: verified — safe to record:**
- Sign up a fresh account on the live server. Show the real Solana + EVM
  addresses it returns from True Markets.
- `tip 5 dollars of pyusd` (or whatever amount the account actually holds, $5+)
  from a pre-funded account, then `confirm`. Show the real status go to FILLED
  and show the resulting `tx_hash` / Solscan link in The Wire. This is a real,
  on-chain, signed transfer — confirmed working end to end.

**What live mode cannot do yet — do not attempt on camera:**
- **Buying or selling any asset (SOL, CBBTC, etc.) in live mode will fail.**
  Every trade on this Gateway settles in USDC; the station wallet currently
  holds PYUSD, not USDC, on no chain does it hold USDC. A live buy/sell attempt
  will show "insufficient balance" or similar. This needs either a USDC
  conversion path from True Markets staff, or a different funding asset,
  before a live trade can be recorded.
- Standing orders and Crowd Calls in live mode inherit the same trading
  block for any buy/sell leg; the tip flow is unaffected.

If a live trade becomes possible before the final recording, redo this section
and update this checklist — do not claim a real fill that was not actually
verified on the Gateway.

## General rules

- Never present a simulated/mock result as a real one, on screen or in narration.
- Hand the live call to someone other than whoever is pitching, where possible.
- If the live voice agent is unreliable, fall back to push-to-talk or the typed
  order box — same backend path, same guarantees.
- Record a backup take once the live flow above is verified working, in case the
  live demo fails in front of judges.

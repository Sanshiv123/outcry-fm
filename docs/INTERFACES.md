# OUTCRY service contracts

All mutations use JSON except audio upload. Signed HttpOnly same-site session
cookies bind every ticket to a customer. APIs never accept a client-selected
customer/user ID. Errors are `{type,message}` with an appropriate HTTP status.
No secrets or unsigned signing payloads are sent to the browser.

| Endpoint | Request | Response |
| --- | --- | --- |
| POST /api/signup | `{email,password,first_name}` | `{email,first_name,wallets,ready}` |
| POST /api/login | `{email,password}` | profile, session cookie |
| POST /api/logout | none | 204 |
| GET /api/me | none | profile |
| GET /api/portfolio | none | Tensho Gateway portfolio |
| GET /api/assets | none | allowed assets + prices |
| GET /api/transactions | none | Gateway transaction page |
| GET /api/station | none | mode, current segment, assets, verified board, limits, provider availability |
| GET /api/wire | none | sanitized calls, timestamps, IDs, status, simulation flags |
| POST /api/tickets | `{asset_id,kind:"buy"\|"sell"\|"tip",amount:"1"}` | immutable ticket; amount is USD |
| GET /api/tickets | none | current customer's last 20 tickets |
| GET /api/tickets/:id | none | ticket; reconciles unknown/submitting status |
| POST /api/tickets/:id/confirm | `{confirm:true}` | confirmed ticket/result; repeat calls only query original order |
| POST /api/tickets/:id/cancel | none | canceled unsubmitted ticket |
| POST /api/orders | `{asset_id,side,amount}` | Tensho-compatible prepared order; buy uses USD, sell uses base quantity |
| POST /api/orders/:id/execute | none (explicit button) | original order ID/status through same policy |
| GET /api/orders/:id | none | owned Gateway order |
| POST /api/transfers | `{asset_id,qty,to}` | prepared transfer, same policy; quantity in base asset |
| POST /api/transfers/:id/execute | none (explicit button) | original transfer ID/status |
| GET /api/transfers/:id | none | owned transfer |
| POST /api/call | `{text,ticket_id?}` | `{reply,ticket?}`; exact “confirm” or “scratch that” binds to ticket |
| POST /api/call/transcribe | raw audio, audio content type, max 5 MB | `{text}` via ElevenLabs |
| POST /api/call/speak | `{text}` | ElevenLabs MP3, or 204 for browser fallback |
| POST /api/call/session | none | short-lived ElevenLabs signed URL + first name |
| GET /api/audio/:file | none | shared rendered show audio |

Ticket: `{id,kind,symbol,asset_id,amount_usd,qty,fee,fee_asset,status,created,expires,upstream,simulated}`.
Fees and estimated receipts in the review come from the Gateway quote. Confirm
only the displayed ID. Changing an order cancels the prior unconfirmed ticket.

Grok script format:
```json
{"lines":[{"speaker":"A","line":"Spoken line."},{"speaker":"B","line":"Spoken reply."}],"assets":["verified-asset-id"]}
```
The show coordinator owns the shared current segment, collects only verified
board entries, renders two voices, and retains the last good provider segment
on provider failure. Clients poll every 2.5 seconds. Browser fallback shares the
script but does not promise sample-accurate audio synchronization.

# Configured for this workspace

- Host Max: Roger (ElevenLabs premade voice).
- Host Jules: Jessica (ElevenLabs premade voice).
- Private OUTCRY call-in agent created with Gemini 2.5 Flash, three ticket tools,
  authentication required, three-minute call duration, four concurrent calls.
- Agent ID and voice IDs are stored in the ignored `.env`.
- Two opening clips, a four-line simulated market bulletin, and a pit bell are generated under `data/audio/`.
- `ENABLE_GROK=false`: no xAI/Grok or Groq requests. The station uses scripted,
  data-backed commentary. The live agent uses Gemini through ElevenLabs.
- Speech rendering caches repeated lines to avoid repeated provider charges.
- Agent creation and signed-session access are verified. A microphone conversation
  still needs a browser rehearsal.

The following sections describe configuration for another environment.

# ElevenLabs configuration

Set server-side `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_A`, and
`ELEVENLABS_VOICE_B` to enable two-host TTS. Without them, the station openly
labels browser speech fallback. `ENABLE_SOUND_EFFECTS=true` generates one cached
pit bell and plays it for a segment with a price move above two percent.

Push-to-talk uses Scribe v2 transcription, an exact-command parser (or Grok
intent extraction for longer requests), then a backend ticket read-back rendered
with ElevenLabs. The transcript is reviewable before sending. If voice fails,
the typed and tapped paths remain available. No sub-three-second latency claim
has been verified.

## Optional live conversational agent

Create a private ElevenLabs agent, select Host A's voice, and set
`ELEVENLABS_AGENT_ID`. The app obtains its signed URL on the backend. Add these
**client tools**, with “wait for response” enabled:

- `quote_order`: required string `asset_id`, enum string `kind` (`buy`, `sell`,
  `tip`), decimal string `amount` in USD.
- `confirm_ticket`: required string `ticket_id`.
- `cancel_ticket`: no parameters.

Paste verified allowed asset IDs from `/api/station` into the agent's context.
Do not use simulation IDs for live assets. Configure first message using
`{{first_name}}`. Suggested system prompt:

> You are Max, the OUTCRY.FM AI host. Greet {{first_name}}. Describe markets,
> never recommend investments. Only draft a ticket when the caller clearly
> specifies an action, amount and asset. Use quote_order. Read its readback
> verbatim, including simulated status, asset, amount, quoted fee and ticket ID.
> Ask the caller to say exactly “confirm” within thirty seconds or “scratch
> that”. Never invent a ticket or report success until a tool reports FILLED.
> Use confirm_ticket only after explicit confirmation; use cancel_ticket for
> cancellation. Never change limits or call a signing service. If confirmation
> fails, ask the caller to tap Confirm on phone. Say dollars and percent, no
> markdown. Hosts are AI. Not financial advice.

The client requires an actual user transcript saying exactly “confirm” for that
same reviewed ticket before honoring the agent's confirm tool. The agent cannot
self-authorize a tool call. The on-phone fallback confirms the same immutable
backend ticket.

Grok is supported through ElevenLabs' custom LLM configuration, but this app does
not change an account's agent settings automatically. Configure a supported
Grok model in ElevenLabs if available, otherwise leave the provider's default
LLM. Grok can write station scripts and parse push-to-talk requests only if explicitly enabled with a key. Do not
claim Grok powers the live agent until its dashboard configuration is verified.

Reference: https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm

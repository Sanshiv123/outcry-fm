# Tensho provenance

Copied from https://github.com/true-markets/examples/tree/main/apps/tensho-wallet
at commit `8e550f82442bc32c9d7a22ddb8a0bfab24f086fc`.

Retained React/Vite/Hono stack, password authentication, signed session cookies,
Gateway organization-token generation, P-256 signing, verified API schemas,
asset catalog, wallet, funding, portfolio and normal trade/send screens.

OUTCRY replaces the mounted order and transfer routes with the shared policy
coordinator. The old route modules remain as upstream reference and are not
mounted. Their original quote-refresh semantics are deliberately replaced.

No license file was present in the copied upstream repository. The MIT license
in this project covers newly authored OUTCRY code only; obtain upstream licensing
clarification before representing the whole derivative as MIT or publishing it.

API references checked:
- https://docs.truemarkets.co/gateway/
- https://docs.truemarkets.co/gateway/requests-and-signing/
- https://docs.x.ai/developers/rest-api-reference/inference/chat-completions
- https://elevenlabs.io/docs/api-reference/text-to-speech/convert
- https://elevenlabs.io/docs/api-reference/speech-to-text/convert
- https://elevenlabs.io/docs/eleven-agents/libraries/java-script

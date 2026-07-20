# ryan-chat worker

Chat proxy for the portfolio's "Ask about Ryan" panel.

The site is a static page on GitHub Pages, so an OpenRouter key placed in it would be readable
by anyone viewing source. This Worker holds the key instead. The browser talks to the Worker,
the Worker talks to OpenRouter, and the key never leaves Cloudflare.

Live at `https://ryan-chat.ryandev1st.workers.dev`, called from `CHAT_URL` in `index.html`.

## Deploy

```bash
cd worker
npx wrangler deploy
```

## Set or rotate the key

```bash
npx wrangler secret put OPENROUTER_KEY
```

The key is a Cloudflare secret. It is not in this repo and not in the deployed page.

## What it guards

The endpoint is public, so it only does what pays for itself:

- **Origin allowlist** so it is not a free general-purpose LLM for the web
- **Fixed model list** so a caller cannot select an expensive model
- **Payload caps** (12 turns of conversation, 2000 chars per visitor message, 700 max_tokens) so
  nobody can bill a huge context. The system message is ours and carries the whole briefing, so it
  gets its own 24000 char allowance and is never trimmed away by the turn limit
- **Server-side model fallback**, because free models 429 intermittently. Only response headers
  are awaited before falling through, so a busy model costs milliseconds and nothing has been
  streamed to the visitor yet.

Spend limits belong on OpenRouter, where they apply account-wide.

## Known provider behaviour: email scrubbing

The free provider strips email addresses out of the payload before the model sees them. Measured:
asked the model to spell back the address in its own system prompt and it returned `[ E M A I L ]`,
and a visitor-typed address came back scrubbed the same way. So the page's system prompt carries the
marker `RYAN_EMAIL` (no `@`, passes through untouched) and `index.html` swaps it for a real `mailto:`
link at render time. Do not put a literal address back in the prompt.

## Changing the allowed origins

Edit `ALLOWED` in `src/index.js` and redeploy. It currently permits the live site plus
localhost for testing.

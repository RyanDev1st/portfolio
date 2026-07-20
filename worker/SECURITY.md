# Attack surface, and what it costs to abuse

The site is a static page. Everything an attacker can reach lives in one Worker with two public
routes and one private one. This is the honest version: what is protected, how, and what is
still open.

| Surface | Exposure | Control |
| --- | --- | --- |
| `POST /` (chat) | Public. Spends model tokens on Ryan's account. | Origin allowlist, `Sec-Fetch-*` required, 20/hour per IP, 250/hour total, fixed model list, 700 max tokens, 12-turn / 2000-char payload cap |
| `POST /react` | Public. Writes KV and sends mail. | All of the above plus proof of work, 2/week counted five ways, per-subnet and per-network daily caps, 30/hour and 120/day endpoint caps |
| `GET /admin` | Public URL, secret query key. | Constant-time compare, 404 on failure, never CORS-exposed, `no-store` |
| `OPENROUTER_KEY` / `RESEND_KEY` / `ADMIN_KEY` | Cloudflare secrets. | Never in the repo, never in the page, not readable from a deployed Worker's responses |

## The limiter

Five counters. A submission is refused if **any** of them is at its cap.

```
per visitor, 2 per week    hashed IP · browser fingerprint · localStorage device id
per network, per day       hashed /24 (or /48) · hashed ASN
whole endpoint             30 per hour · 120 per day
```

The three visitor-level counters exist because each is individually easy to shed: clearing
storage resets the device id, a browser update or a resized window moves the fingerprint, and a
phone changes IP by walking outdoors. Requiring all three to be clear means shedding one buys
nothing. **Measured:** a caller presenting a fresh device id and fresh fingerprint on every
request, which is what switching browsers looks like, is still cut off after two.

The network-level counters are the answer to the next move, which is shedding all three at once.
They are deliberately loose, because a /24 and an ASN are shared by real unrelated people, so
they are a ceiling on abuse rather than a per-visitor limit.

Identifiers are salted and hashed in the Worker before they are stored. KV holds nothing that
identifies anyone, and the stored reactions carry no address, no id, and no fingerprint.

## Proof of work

An `Origin` header proves nothing, because anything that is not a browser can simply send one.
So each submission must carry a nonce whose SHA-256 over the exact payload begins with 14 zero
bits, with the timestamp inside the hashed material and a 5-minute validity window.

A visitor pays about 16k hashes once, invisibly. **Measured: 4297 tries, 206ms.** A flood pays
it per request, which turns a free loop into a metered one.

This is friction, not a bot wall. A determined attacker with native code will out-hash a browser
by orders of magnitude. Its job is to make *probing the caps above* expensive, and to price out
the trivial `while true; do curl; done`.

## What is still open, honestly

- **Proof of work is not a human check.** The real wall is Turnstile. The Worker already
  verifies it; enable with `npx wrangler secret put TURNSTILE_SECRET` and put the site key in
  the page. Until then, a determined scripted attacker who implements the PoW in native code can
  still reach the caps, which is why the caps exist.
- **KV is eventually consistent.** A tight burst can slip a few submissions past a counter. The
  caps bound the damage; they are not exact accounting.
- **Replay inside the PoW window.** A captured valid stamp can be resent for up to 5 minutes.
  Each replay still consumes quota, so it buys nothing an attacker did not already have.
- **A botnet spread across many networks** defeats every per-identity counter by construction.
  The endpoint-wide hourly and daily caps are what stands between that and the inbox, and they
  are set low deliberately: a real portfolio does not receive 120 reactions in a day.
- **The admin key travels in the URL**, so it lands in browser history. Rotate it with
  `npx wrangler secret put ADMIN_KEY` if that matters.
- **The system prompt ships publicly** in the page. That is by design. Only facts already on the
  site belong in it, and it carries no private contact details.

## If something goes wrong

```bash
npx wrangler secret put OPENROUTER_KEY     # rotate the model key
npx wrangler secret put ADMIN_KEY          # rotate the reactions key
npx wrangler kv key list --namespace-id <id> --remote   # inspect counters and records
```

Lowering `HOUR_CAP` or `DAY_CAP` in `src/index.js` and redeploying takes effect immediately, and
setting `PER_WEEK` to `0` closes reactions entirely without touching the page.

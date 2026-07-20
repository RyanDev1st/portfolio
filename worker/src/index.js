/* Ask-about-Ryan chat proxy.
   The portfolio is a static page on GitHub Pages, so an OpenRouter key placed in it would be
   readable by anyone. This Worker holds the key instead: the browser calls the Worker, the
   Worker calls OpenRouter, and the key never leaves Cloudflare.

   Set the secret once:  npx wrangler secret put OPENROUTER_KEY

   Deliberately small. The only guards are the ones that pay for themselves:
   - origin allowlist, so the endpoint is not a free general-purpose LLM for the whole web
   - a hard cap on message count and max_tokens, so one caller cannot bill a huge context
   - a fixed model chain, so the caller cannot select an expensive model
   Everything else (per-account spend limits) is configured on OpenRouter, where it belongs. */

const ALLOWED = [
  'https://ryandev1st.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

// Ordered by MEASURED time to first token and availability, not by reputation. hy3 answered in
// ~1.7s while gpt-oss was returning 429s, and a 429 on the first model makes the visitor pay a
// whole failed round trip before anything streams. gpt-oss stays as the backup because its
// answers are good when it is up. The client cannot choose, so nobody can point this at a paid
// model. Re-measure before reordering; the free tier moves.
const MODELS = ['tencent/hy3:free', 'openai/gpt-oss-20b:free', 'nvidia/nemotron-3-super-120b-a12b:free'];

const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin'
});

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const ok = ALLOWED.includes(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: ok ? 204 : 403, headers: ok ? cors(origin) : {} });
    }
    if (request.method !== 'POST') return new Response('POST only', { status: 405 });
    if (!ok) return new Response('Origin not allowed', { status: 403 });
    if (!env.OPENROUTER_KEY) return new Response('Not configured', { status: 500, headers: cors(origin) });

    let body;
    try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: cors(origin) }); }

    // Trim the CONVERSATION, never the system prompt. A plain slice(-10) silently drops the
    // first message once a chat runs long, which is exactly the message that tells the model
    // who Ryan is: the bot would keep answering while quietly knowing nothing.
    const all = Array.isArray(body.messages) ? body.messages : null;
    if (!all || !all.length) return new Response('No messages', { status: 400, headers: cors(origin) });
    const sys = all[0] && all[0].role === 'system' ? [all[0]] : [];
    const msgs = sys.concat(all.slice(sys.length).slice(-12));
    // Cap the payload so a caller cannot push a huge context through this key. The system
    // message is ours and carries the whole briefing, so it gets room; everything a visitor
    // can actually type is held short, which is the part that needs limiting.
    for (const m of msgs) {
      const limit = m.role === 'system' ? 24000 : 2000;
      if (typeof m.content !== 'string' || m.content.length > limit) {
        return new Response('Message too long', { status: 400, headers: cors(origin) });
      }
    }

    // Model fallback lives HERE, not in the page. Free models 429 intermittently (measured on
    // both gemma variants while these two answered fine), and doing the retry server-side
    // means one browser request instead of a failed round trip plus a second one. Only the
    // headers are awaited before falling through, so a model that is busy costs milliseconds
    // and nothing has been streamed to the visitor yet.
    let upstream = null;
    for (const model of MODELS) {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENROUTER_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://ryandev1st.github.io/portfolio/',
          'X-Title': 'Ryan Portfolio'
        },
        // 400 truncated real answers mid sentence: a reply that explains something AND hands
        // off with contact details runs past it, and the visitor saw "He is at ryandev..., Gi".
        // 700 leaves room for the handoff to complete. Brevity is enforced by the prompt, not
        // by cutting the model off in the middle of a word.
        body: JSON.stringify({ model, stream: true, max_tokens: 700, temperature: 0.3, messages: msgs })
      });
      if (r.ok) { upstream = r; break; }
      // 4xx that is not a rate limit is our bug (bad payload, bad key): surface it rather
      // than burning the rest of the chain on a request that will fail the same way.
      if (r.status !== 429 && r.status < 500) {
        return new Response(await r.text(), { status: r.status, headers: cors(origin) });
      }
    }
    if (!upstream) return new Response('All models busy', { status: 503, headers: cors(origin) });

    // Pass the stream straight through so the page can render tokens as they arrive.
    return new Response(upstream.body, {
      status: 200,
      headers: { ...cors(origin), 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' }
    });
  }
};

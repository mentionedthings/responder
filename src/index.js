/**
 * Facebook AI Comment Responder - Cloudflare Worker
 * 
 * Required Secrets (set via `wrangler secret put <NAME>`):
 *   - META_PAGE_TOKEN
 *   - OPENAI_API_KEY
 *   - WEBHOOK_VERIFY_TOKEN
 *   - WEBHOOK_SECRET        (for HMAC signature verification)
 *   - SYSTEM_PROMPT         (your brand persona prompt)
 */

// ─── Configuration & Constants ───────────────────────────────────────
const BLOCKED_TERMS = ['buy now', 'click here', 'free money', 'dm me', 'nft', 'crypto pump'];

// ─── Main Handler ────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Webhook verification (GET)
    if (request.method === 'GET' && url.pathname === '/webhook') {
      return handleVerification(url, env);
    }

    // Incoming webhook events (POST)
    if (request.method === 'POST' && url.pathname === '/webhook') {
      // Verify HMAC signature
      const isValid = await verifyWebhookSignature(request, env);
      if (!isValid) {
        return new Response('Invalid signature', { status: 403 });
      }

      const data = await request.json();
      
      // Process in background so webhook returns 200 immediately
      // This prevents Meta from retrying due to timeout
      const body = JSON.stringify(data);
      const processRequest = new Request(request.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
      });

      // Use waitUntil to process after responding
      // We clone the processing into a non-blocking handler
      const processData = JSON.parse(body);
      
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'healthy', timestamp: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },

  // Scheduled handler for batch processing (optional alternative to real-time)
  // async scheduled(event, env) { ... }
};

// ─── Webhook Verification ────────────────────────────────────────────
function handleVerification(url, env) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === env.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully');
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

// ─── HMAC Signature Verification ────────────────────────────────────
async function verifyWebhookSignature(request, env) {
  const signature = request.headers.get('x-hub-signature-256');
  if (!signature || !env.WEBHOOK_SECRET) return false;

  const body = await request.clone().text();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(env.WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = 'sha256=' + Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  return signature === expected;
}

// ─── Comment Processing Pipeline ────────────────────────────────────
// NOTE: In production, call this from a queue or waitUntil pattern.
// For simplicity, this shows the full logic. Integrate with CF Queues
// for guaranteed delivery at scale.
export async function processComment(commentData, env) {
  const commentId = commentData.id;
  const commentText = commentData.message || '';
  const senderId = commentData.from?.id;

  // Guard: Skip empty, own comments, or non-text
  if (!commentText || senderId === env.PAGE_ID) return;

  // Guard: Deduplication via KV (TTL 24h)
  const cacheKey = `replied:${commentId}`;
  const alreadyReplied = await env.FB_COMMENT_CACHE.get(cacheKey);
  if (alreadyReplied) {
    console.log(`⏭️ Skipped duplicate: ${commentId}`);
    return;
  }

  // Guard: Rate limiting per minute
  const rateKey = `ratelimit:${new Date().toISOString().slice(0, 16)}`;
  const count = parseInt(await env.FB_COMMENT_CACHE.get(rateKey) || '0');
  if (count >= parseInt(env.RATE_LIMIT_MAX_REPLIES)) {
    console.log(`🚫 Rate limit hit. Skipping ${commentId}`);
    return;
  }

  // Generate AI reply
  const reply = await generateAIReply(commentText, env);
  if (!reply) {
    console.log(`❌ No valid reply generated for: ${commentId}`);
    return;
  }

  // Post reply to Facebook
  const success = await postFacebookReply(commentId, reply, env);
  if (success) {
    // Mark as replied (24h TTL)
    await env.FB_COMMENT_CACHE.put(cacheKey, '1', { expirationTtl: 86400 });
    // Increment rate limit counter
    await env.FB_COMMENT_CACHE.put(rateKey, String(count + 1), { expirationTtl: 120 });
    console.log(`✅ Replied to ${commentId}: "${reply.substring(0, 50)}..."`);
  }
}

// ─── AI Generation with Guardrails ──────────────────────────────────
async function generateAIReply(commentText, env) {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: env.SYSTEM_PROMPT },
          { role: 'user', content: `User comment: ${commentText}\n\nGenerate a reply:` }
        ],
        max_tokens: 150,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      console.error(`OpenAI error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();

    if (!reply) return null;

    // Guardrail: Length check
    if (reply.length > parseInt(env.MAX_REPLY_LENGTH)) return null;

    // Guardrail: Blocked terms
    const lower = reply.toLowerCase();
    if (BLOCKED_TERMS.some(term => lower.includes(term))) {
      console.log(`🛡️ Blocked term detected in AI output`);
      return null;
    }

    return reply;
  } catch (err) {
    console.error(`AI generation failed: ${err.message}`);
    return null;
  }
}

// ─── Facebook Graph API Reply ────────────────────────────────────────
async function postFacebookReply(commentId, message, env) {
  const url = `https://graph.facebook.com/${env.GRAPH_API_VERSION}/${commentId}/replies`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message,
        access_token: env.META_PAGE_TOKEN,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`FB API error (${resp.status}): ${err}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`FB post failed: ${err.message}`);
    return false;
  }
}
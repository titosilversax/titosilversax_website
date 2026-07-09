// Kit purchase webhook -> Meta Conversions API bridge.
//
// Kit fires purchase.purchase_create at this endpoint; we forward a
// server-side Purchase event to Meta so ad attribution works without
// touching Kit's file delivery or relying on browser pixels.
//
// Required Vercel environment variables:
//   META_CAPI_ACCESS_TOKEN  - Meta Events Manager > Settings > Conversions API token
//   KIT_WEBHOOK_SECRET      - shared secret; must match ?secret= on the webhook URL

const crypto = require('crypto');

const META_PIXEL_ID = '830210888742452';
const GRAPH_URL = `https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events`;

function sha256(value) {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const secret = process.env.KIT_WEBHOOK_SECRET;
  if (!secret || req.query.secret !== secret) {
    res.status(401).json({ error: 'bad secret' });
    return;
  }

  const token = process.env.META_CAPI_ACCESS_TOKEN;
  if (!token) {
    // Token not configured yet. Acknowledge so Kit doesn't disable the
    // webhook; the event is dropped until the env var is set.
    console.warn('kit-purchase: META_CAPI_ACCESS_TOKEN not set, dropping event');
    res.status(200).json({ ok: true, skipped: 'no capi token' });
    return;
  }

  // Kit nests the purchase under `purchase` in some payloads and sends it
  // flat in others; read both shapes defensively.
  const body = req.body || {};
  const purchase = body.purchase || body;

  const email =
    purchase.email_address ||
    (body.subscriber && body.subscriber.email_address) ||
    null;

  const value = Number(purchase.total ?? purchase.subtotal ?? 0);
  const currency = (purchase.currency || 'USD').toUpperCase();
  const eventId = String(
    purchase.transaction_id || purchase.id || crypto.randomUUID()
  );

  const event = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId, // dedupes against any browser-side pixel event
    action_source: 'website',
    event_source_url: 'https://titosilversax.com/practice',
    user_data: email ? { em: [sha256(email)] } : {},
    custom_data: { currency, value },
  };

  try {
    const metaRes = await fetch(`${GRAPH_URL}?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [event] }),
    });
    const metaBody = await metaRes.json();

    if (!metaRes.ok) {
      console.error('kit-purchase: Meta CAPI error', metaRes.status, metaBody);
      // Still 200: the purchase itself succeeded and Kit retries are not
      // useful for a permanent config error.
      res.status(200).json({ ok: false, meta_status: metaRes.status });
      return;
    }

    res.status(200).json({ ok: true, events_received: metaBody.events_received });
  } catch (err) {
    console.error('kit-purchase: forward failed', err);
    res.status(200).json({ ok: false });
  }
};

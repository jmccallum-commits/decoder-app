// Fired by a Postgres trigger the moment a ticket is inserted.
// Emails you the question, the link, and the screenshot.

const SB     = process.env.SUPABASE_URL;
const SKEY   = process.env.SUPABASE_SERVICE_KEY;
const RESEND = process.env.RESEND_API_KEY;
const TO     = process.env.NOTIFY_EMAIL;                     // where it lands
const FROM   = process.env.NOTIFY_FROM || 'Decoder <onboarding@resend.dev>';
const SITE   = process.env.URL;

const reply = (code, obj) => ({ statusCode: code, headers:{'Content-Type':'application/json'}, body: JSON.stringify(obj) });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  if (!SB || !SKEY || !RESEND || !TO) return reply(500, { error: 'Missing environment variables' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Bad JSON' }); }

  // ---- a follow-up message on an existing ticket ----
  if (payload.message_id) {
    const mr = await fetch(`${SB}/rest/v1/messages?id=eq.${payload.message_id}&select=*`, {
      headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}` }
    });
    const [m] = await mr.json();
    if (!m) return reply(404, { error: 'No such message' });

    const tr = await fetch(`${SB}/rest/v1/tickets?id=eq.${m.ticket_id}&select=num,handle,question`, {
      headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}` }
    });
    const [tk] = await tr.json();
    const n = tk ? String(tk.num).padStart(4, '0') : '????';
    const from = tk && tk.handle ? esc(tk.handle) : 'they';

    const html = `
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:22px;background:#151125;color:#EFEAF7;border-radius:14px">
  <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9E95BC;margin-bottom:14px">
    Ticket ${n} &middot; ${from} wrote back
  </div>
  <div style="font-size:17px;line-height:1.5;margin-bottom:18px;white-space:pre-wrap">${esc(m.body)}</div>
  <a href="${SITE}/#desk" style="display:block;text-align:center;background:#FFB43D;color:#241703;text-decoration:none;font-weight:700;font-size:16px;padding:14px;border-radius:10px">
    Reply
  </a>
</div>`;

    const s = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM, to: [TO],
        subject: `Ticket ${n}: ${m.body.slice(0, 60)}`,
        html
      })
    });
    if (!s.ok) { console.error('resend failed', await s.text()); return reply(502, { error: 'Email did not send' }); }
    return reply(200, { ok: true });
  }

  // ---- a brand new ticket ----
  const id = payload.id;
  if (!id) return reply(400, { error: 'No ticket id' });

  // load the ticket
  const r = await fetch(`${SB}/rest/v1/tickets?id=eq.${id}&select=*`, {
    headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}` }
  });
  const [t] = await r.json();
  if (!t) return reply(404, { error: 'No such ticket' });

  // a signed link to the screenshot, good for a week so the email stays useful
  let img = null;
  if (t.media_path) {
    try {
      const s = await fetch(`${SB}/storage/v1/object/sign/posts/${t.media_path}`, {
        method: 'POST',
        headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 7 })
      });
      const d = await s.json();
      if (d.signedURL) img = `${SB}/storage/v1${d.signedURL}`;
    } catch (e) { console.error('sign failed', e); }
  }

  const num = String(t.num).padStart(4, '0');
  const who = t.handle ? esc(t.handle) : 'someone';
  const deskLink = `${SITE}/#desk`;

  const html = `
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:22px;background:#151125;color:#EFEAF7;border-radius:14px">
  <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9E95BC;margin-bottom:14px">
    Ticket ${num} &middot; from ${who}
  </div>
  <div style="font-size:18px;line-height:1.45;margin-bottom:16px">
    ${t.question ? esc(t.question) : 'No question &mdash; they just want to know what it is.'}
  </div>
  ${t.link ? `<div style="margin-bottom:16px"><a href="${esc(t.link)}" style="color:#FFB43D;font-size:13px;word-break:break-all">${esc(t.link)}</a></div>` : ''}
  ${img ? `<img src="${img}" alt="" style="width:100%;border-radius:10px;border:1px solid #332B54;margin-bottom:18px">` : ''}
  <a href="${deskLink}" style="display:block;text-align:center;background:#FFB43D;color:#241703;text-decoration:none;font-weight:700;font-size:16px;padding:14px;border-radius:10px">
    Answer it
  </a>
  <div style="font-size:12px;color:#9E95BC;margin-top:16px;text-align:center">
    Five minutes on the meter, then the machine takes it.
  </div>
</div>`;

  const send = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [TO],
      subject: `Ticket ${num}: ${t.question ? t.question.slice(0, 60) : 'what is this?'}`,
      html
    })
  });

  if (!send.ok) {
    const txt = await send.text();
    console.error('resend failed', txt);
    return reply(502, { error: 'Email did not send' });
  }
  return reply(200, { ok: true });
};

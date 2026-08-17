// Answers a follow-up inside a thread, but only on tickets where the
// person asked for the machine. Human-answered tickets are left alone.

const SB   = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_SERVICE_KEY;
const AKEY = process.env.ANTHROPIC_API_KEY;

const H = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };
const reply = (code, obj) => ({ statusCode: code, headers:{'Content-Type':'application/json'}, body: JSON.stringify(obj) });

async function rest(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, Prefer: 'return=representation' } });
  const txt = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  if (!SB || !SKEY || !AKEY) return reply(500, { error: 'Missing environment variables' });

  let ticket_id;
  try { ticket_id = JSON.parse(event.body || '{}').ticket_id; } catch { return reply(400, { error: 'Bad JSON' }); }
  if (!ticket_id) return reply(400, { error: 'No ticket id' });

  const [t] = await rest(`tickets?id=eq.${ticket_id}&select=*`);
  if (!t) return reply(404, { error: 'No such ticket' });
  if (t.answer_by !== 'ai_now') return reply(200, { skipped: 'this one is waiting on a person' });

  const msgs = await rest(`messages?ticket_id=eq.${ticket_id}&select=role,body,created_at&order=created_at.asc`);
  if (!msgs || !msgs.length) return reply(200, { skipped: 'nothing to answer' });
  const last = msgs[msgs.length - 1];
  if (last.role !== 'asker') return reply(200, { skipped: 'already answered' });

  // the image again, so follow-ups can still refer to the picture
  let media = null;
  if (t.media_path) {
    try {
      const m = await fetch(`${SB}/storage/v1/object/posts/${t.media_path}`, {
        headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}` }
      });
      if (m.ok) {
        const buf = Buffer.from(await m.arrayBuffer());
        media = { type: m.headers.get('content-type') || 'image/jpeg', data: buf.toString('base64') };
      }
    } catch (e) { console.error('media fetch failed', e); }
  }

  const opening = [];
  if (media) opening.push({ type: 'image', source: { type: 'base64', media_type: media.type, data: media.data } });
  opening.push({ type: 'text', text:
`${t.ask_type === 'ai_check'
  ? 'This person asked whether the attached image was made or altered by AI.'
  : 'This person sent in a social media post and asked to have it explained in plain language.'}

What they first asked: ${t.question || '(nothing specific)'}
${t.link ? 'Link they gave: ' + t.link : ''}

Keep answering their follow-ups. Be direct and specific, say plainly when you cannot tell rather than guessing, and keep each reply under 120 words. No greeting, no sign-off.${
  t.ask_type === 'ai_check'
    ? ' Remember there is no way to prove an image is AI by looking at it — give your read and be clear it is a read.'
    : ''}`});

  const history = [{ role: 'user', content: opening }];
  if (t.answer) history.push({ role: 'assistant', content: t.answer });
  for (const m of msgs) {
    history.push({ role: m.role === 'asker' ? 'user' : 'assistant', content: m.body });
  }

  let text = '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': AKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, messages: history })
    });
    const d = await r.json();
    text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  } catch (e) { console.error('anthropic failed', e); }

  if (!text) return reply(502, { error: 'No reply came back' });

  // last check — a person may have jumped in while we were thinking
  const fresh = await rest(`messages?ticket_id=eq.${ticket_id}&select=role&order=created_at.desc&limit=1`);
  if (fresh && fresh[0] && fresh[0].role !== 'asker') return reply(200, { skipped: 'someone else replied' });

  await rest('messages', {
    method: 'POST',
    body: JSON.stringify({ ticket_id, author: t.owner, role: 'ai', body: text })
  });

  return reply(200, { ok: true });
};

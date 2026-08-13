// POST { "id": "<ticket uuid>" }
// Answers a ticket that has been sitting open for 5+ minutes.
// Runs server-side so the Anthropic key and the Supabase service key
// never touch the browser.

const SB    = process.env.SUPABASE_URL;
const SKEY  = process.env.SUPABASE_SERVICE_KEY;
const AKEY  = process.env.ANTHROPIC_API_KEY;
const GRACE = 5 * 60 * 1000;

const sbHeaders = {
  apikey: SKEY,
  Authorization: `Bearer ${SKEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation'
};

async function rest(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: sbHeaders });
  const txt = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  if (!SB || !SKEY || !AKEY) return reply(500, { error: 'Missing environment variables' });

  let id;
  try { id = JSON.parse(event.body || '{}').id; } catch { return reply(400, { error: 'Bad JSON' }); }
  if (!id) return reply(400, { error: 'No ticket id' });

  // 1. load it
  const [t] = await rest(`tickets?id=eq.${id}&select=*`);
  if (!t) return reply(404, { error: 'No such ticket' });
  if (t.status === 'answered') return reply(200, { skipped: 'already answered' });

  // 2. is the meter actually expired?
  const age = Date.now() - new Date(t.created_at).getTime();
  if (age < GRACE) return reply(200, { skipped: 'still on the meter' });

  // 3. claim it — the filter on status makes this atomic, so two
  //    browsers hitting this at once cannot both get through
  const claimed = await rest(`tickets?id=eq.${id}&status=eq.open`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'reading', claimed_at: new Date().toISOString() })
  });
  if (!claimed || !claimed.length) {
    // stale 'reading' from a crashed run? let it go after 3 minutes
    if (t.status === 'reading' && Date.now() - new Date(t.claimed_at || 0).getTime() < 3 * 60 * 1000) {
      return reply(200, { skipped: 'another run has it' });
    }
  }

  // 4. pull the image out of storage
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

  // 5. read it
  const content = [];
  if (media) {
    content.push({ type: 'image', source: { type: 'base64', media_type: media.type, data: media.data } });
  }
  content.push({
    type: 'text',
    text:
`Someone sent in a social media post and wants it explained in plain language.

Their question: ${t.question || 'What does this mean?'}
${t.link ? 'Link they gave: ' + t.link : ''}
${media
  ? (t.kind === 'video'
      ? 'Attached: three frames pulled from their video, stacked top to bottom.'
      : 'Attached: their screenshot of the post.')
  : 'No image was attached.'}

Explain what the post is actually saying and why: the slang, the reference, the joke, the subtext, the tone. Be direct and specific. Say plainly what you cannot tell instead of guessing confidently. No greeting, no sign-off, under 140 words.`
  });

  const body = { model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content }] };
  if (!media && t.link) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

  let text = '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': AKEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  } catch (e) {
    console.error('anthropic failed', e);
  }

  // 6. write it back — unless a person got there first
  const [now] = await rest(`tickets?id=eq.${id}&select=status`);
  if (now && now.status === 'answered') return reply(200, { skipped: 'a person beat the machine' });

  if (!text) {
    await rest(`tickets?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'open' }) });
    return reply(502, { error: 'No reading came back' });
  }

  await rest(`tickets?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      answer: text,
      status: 'answered',
      answered_by: 'ai',
      answered_at: new Date().toISOString()
    })
  });

  return reply(200, { ok: true });
};

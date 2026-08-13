// Runs every minute (see netlify.toml).
// Catches any ticket whose meter ran out while nobody had the app open.

const SB   = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_SERVICE_KEY;
const SITE = process.env.URL; // Netlify sets this to your live site URL

exports.handler = async () => {
  if (!SB || !SKEY) return { statusCode: 500, body: 'Missing environment variables' };

  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const r = await fetch(
    `${SB}/rest/v1/tickets?status=eq.open&created_at=lt.${cutoff}&select=id&order=created_at.asc&limit=10`,
    { headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}` } }
  );
  const overdue = await r.json();

  for (const t of overdue || []) {
    try {
      await fetch(`${SITE}/.netlify/functions/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: t.id })
      });
    } catch (e) { console.error('sweep failed on', t.id, e); }
  }

  return { statusCode: 200, body: `swept ${(overdue || []).length}` };
};

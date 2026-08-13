# Decoder — deploy notes

Four files. Drop the whole folder into a GitHub repo, connect it to Netlify, done.

```
index.html                      the app
supabase.sql                    run once in Supabase
netlify.toml                    build + the every-minute sweep
netlify/functions/explain.js    the AI reader (holds the keys)
netlify/functions/sweep.js      catches tickets nobody was watching
```

---

## 1. Supabase (about 5 minutes)

1. New project → **SQL Editor** → paste all of `supabase.sql` → Run.
2. **Auth → Sign In / Providers → Anonymous sign-ins → ON.**
   That is how someone can send a ticket without making an account.
3. **Auth → Users → Add user** → your email + a password. Copy the UID.
4. Back in SQL Editor:
   ```sql
   insert into public.admins (user_id) values ('paste-your-uid');
   ```
   That account is the only one that sees the desk.
5. **Settings → API** → copy the **Project URL** and the **anon public** key.

## 2. index.html

Near the top of the script, replace:

```js
const SUPABASE_URL      = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
```

The anon key is meant to be public — row level security is what protects the data.
The service key is not, and it never appears in this file.

## 3. Netlify

Deploy the folder, then **Site settings → Environment variables**:

| Key | Where it comes from |
|---|---|
| `SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase → Settings → API → **service_role** key |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys |

Redeploy after adding them. Netlify sets `URL` on its own — leave that alone.

---

## How the five minutes actually work

- A ticket is inserted with `status = 'open'`.
- Any open browser watching an expired ticket pings `explain`. The sweep function
  also runs every minute, so it fires with nobody looking.
- `explain` claims the row with `PATCH ... &status=eq.open`. That filter is what
  makes it atomic — the second caller gets an empty result and backs off, so no
  ticket ever gets answered twice.
- Before writing, it re-checks the status. If you answered in the meantime, the
  machine drops its draft.

## Changing the meter

`GRACE_MS` in `index.html`, `GRACE` in `explain.js`, and the `cutoff` in
`sweep.js` all have to agree. Three places, same number.

## Notes

- The `posts` bucket is **private**. No image is reachable by URL alone. The app asks
  Supabase for a signed link that dies after an hour, and only the person who
  uploaded it or the desk account is allowed to ask. If a link leaks, it stops
  working by itself.
- The AI reader pulls the file server-side with the service key, so it does not
  need a signed link at all.
- Uploaded videos never leave the phone — three frames get pulled in the browser and
  only that strip is stored. Cheap, and it is what the model can actually read.
- Submitters only ever see their own tickets. RLS enforces that at the database,
  not in the UI.

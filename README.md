# CraveNG

Food discovery and ordering platform for Minna, Niger State.

Twenty kitchens, guest checkout, a vendor dashboard for managing orders, and an
admin dashboard for the whole marketplace. Data lives in Supabase.

## Files

| File | Purpose |
|---|---|
| `index.html` | The entire application, photographs included |
| `vercel.json` | Caching rules for Vercel |
| `supabase-schema.sql` | Database schema — run once in Supabase |
| `README.md` | This file |
| `.gitignore` | Keeps editor and OS junk out of the repo |
| `.env.example` | Documents that no environment variables are used |

No build step, no dependencies, no `npm install`.

---

## Important: it must be served over HTTP

Double-clicking `index.html` will **not** connect to Supabase. A page opened
from disk (`file:///...`) has no web origin, so the browser blocks the request
before sending it. You will see:

```
[CraveNG] Supabase NOT connected — The page is open directly from your
computer (file://), so the browser blocked the request to Supabase.
```

That is expected, and is not a fault in the project or your credentials.
Deploying to Vercel fixes it, because the site is then served over `https://`.

To check locally instead, run `python3 -m http.server 8000` in this folder and
open **http://localhost:8000**.

---

## Setup

### 1. Create the database tables

Supabase → **SQL Editor** → New query → paste all of `supabase-schema.sql` →
**Run**. It is safe to run more than once.

Do this *before* opening the deployed site, or the app will correctly report
"The tables do not exist yet".

It creates six tables:

| Table | Holds |
|---|---|
| `cng_vendors` | kitchens, credentials, hours, fees, open/closed state |
| `cng_menu_items` | dishes with price, description, availability |
| `cng_orders` | orders, payment method and status, delivery details |
| `cng_customers` | guest customers, keyed by phone number |
| `cng_reviews` | reviews and moderation state |
| `cng_settings` | platform and homepage configuration |

The kitchen catalogue seeds itself on the first successful connection.

### 2. Push to GitHub

Upload the six files to a new repository. On a phone, use **Add file → Upload
files** for `index.html`, `vercel.json`, `supabase-schema.sql` and `README.md`.

For `.gitignore` and `.env.example`, use **Add file → Create new file** and type
the filename by hand — GitHub's uploader can be awkward with files that start
with a dot.

### 3. Deploy on Vercel

1. Go to **https://vercel.com/new**
2. **Import Git Repository** and pick the repo.
3. Leave every setting at its default:
   - Framework preset: **Other**
   - Build command: **empty**
   - Output directory: **empty**
   - Root directory: **./**
4. **Deploy**.

You get a URL like `craveng.vercel.app`. Every later push redeploys.

### 4. Verify the connection

Open the deployed site and check the browser console. Success looks like:

```
[CraveNG] Supabase connected
```

If it fails, the on-screen message names the cause:

| Message | Cause | Fix |
|---|---|---|
| The tables do not exist yet | schema not run | run `supabase-schema.sql` |
| Supabase rejected the API key | wrong key | recopy from Settings → API |
| Row Level Security blocked the request | policies missing | re-run the RLS block in the schema |
| Could not reach `<host>` | project paused | free Supabase projects pause after a week — press Restore |

---

## Configuration

Supabase credentials sit at the top of the `<script>` block in `index.html`.
Search for `CNG_CONFIG`:

```js
const CNG_CONFIG = {
  backend: 'supabase',
  url:  'https://YOUR-REF.supabase.co',
  key:  'sb_publishable_...',
  table:'cng_settings',
  strict: true,
};
```

`strict: true` means Supabase is the only store: if it is unreachable the app
stops and explains why, rather than quietly falling back to browser storage.
That is the right setting while you are verifying the connection. Once you are
taking real orders, `strict: false` is safer — a customer can still order
through a brief outage.

---

## Demo access

- **Vendor dashboard** — chef icon in the header. Pick a kitchen from the
  dropdown and press *Sign in instantly*, or use `CNG-V01` with the password
  shown on the login page.
- **Admin dashboard** — *Admin* in the footer. Passcode `craveng2026`.

---

## A note on file size

`index.html` is about 1.9 MB because the twenty photographs are embedded
directly in it. That keeps the project to a single file, which is ideal for
uploading from a phone.

If you later want faster repeat visits, split the photographs into an
`images/` folder and reference them by path — the browser will then cache them
separately instead of re-downloading them with every page load.

---

## Before real customers

This is a working demo, not yet a production system:

- **Vendor and admin passwords are visible in the page source.** Anyone can
  read them with View Source. Replace them with Supabase Auth.
- **The RLS policies are deliberately permissive** so the demo works with only
  a publishable key. Anyone with that key can read every order and phone
  number. The hardening checklist is at the foot of `supabase-schema.sql`.
- **Customer names, phone numbers and addresses are personal data.** Restrict
  access to the owning kitchen and to admins once authentication is in place.

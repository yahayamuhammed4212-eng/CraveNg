/* =====================================================================
   GET /api/rest-test
   ---------------------------------------------------------------------
   A raw, unfiltered REST probe. Sends ONLY the apikey header, exactly as
   Supabase documents for new sb_secret_ keys â€” no Authorization, no
   Bearer token, no client library.

   It reports the exact URL string it called and Supabase's unedited
   reply, so we can tell three very different failures apart:

     A. key not recognised        -> 401 on every path, including the root
     B. key recognised, no role   -> root OK, every table 42501
     C. specific table ungranted  -> some tables readable, one 42501

   The key itself is never returned; only its length and first characters.
   ===================================================================== */
import { ENV, keyDiagnostics, keyKind } from './_lib.js';

function base(){
  return ENV.sbUrl.replace(/\/+$/,'').replace(/\/rest\/v1$/,'');
}

async function probe(path, label){
  const url = base() + path;
  const out = {label, url, sentHeaders:['apikey'], status:null, code:null, message:null, ok:false};
  try{
    const r = await fetch(url, {
      headers: {
        apikey: ENV.sbService,          // <- the ONLY auth header sent
        Accept: 'application/json',
      },
    });
    out.status = r.status;
    out.ok = r.ok;
    /* Supabase/Kong echo useful routing hints; surface a safe subset. */
    out.responseHeaders = {
      server: r.headers.get('server'),
      'content-profile': r.headers.get('content-profile'),
      'sb-gateway-version': r.headers.get('sb-gateway-version'),
      'x-kong-upstream-status': r.headers.get('x-kong-upstream-status'),
    };
    const txt = await r.text();
    let body = null; try{ body = JSON.parse(txt); }catch(e){}
    if(body && typeof body === 'object' && !Array.isArray(body)){
      out.code = body.code || null;
      out.message = String(body.message || body.hint || body.error || '').slice(0, 300);
    } else if(Array.isArray(body)){
      out.message = 'returned ' + body.length + ' row(s)';
    } else {
      out.message = String(txt || '').slice(0, 200);
    }
  }catch(e){
    out.status = 0;
    out.message = 'fetch threw: ' + e.message;
  }
  return out;
}

export default async function handler(req, res){
  res.setHeader('Cache-Control','no-store');

  const urlRef = (() => {
    try{ return new URL(base()).host.split('.')[0]; }catch(e){ return null; }
  })();

  const result = {
    projectRefFromUrl: urlRef,               // must match your Supabase project
    urlUsed: base(),                         // the exact origin every call uses
    key: keyDiagnostics(),                   // never the key itself
    keyFormat: keyKind(),
    headerPolicy: 'apikey only (no Authorization, no Bearer)',
    probes: [],
  };

  /* Ordered so the comparison is meaningful. */
  result.probes.push(await probe('/rest/v1/', 'PostgREST root (does the gateway accept the key at all?)'));
  result.probes.push(await probe('/rest/v1/cng_orders?select=id&limit=1', 'cng_orders'));
  result.probes.push(await probe('/rest/v1/cng_vendors?select=id&limit=1', 'cng_vendors'));
  result.probes.push(await probe('/rest/v1/cng_settings?select=key&limit=1', 'cng_settings'));
  result.probes.push(await probe('/rest/v1/definitely_not_a_table?select=id&limit=1', 'control: table that does not exist'));

  const root   = result.probes[0];
  const tables = result.probes.slice(1, 4);
  const ghost  = result.probes[4];

  if(tables.every(p => p.ok)){
    result.verdict = 'WORKING. The key is accepted and every table is readable with apikey only.';
    result.nextStep = 'No further action needed.';
  } else if(result.probes.every(p => p.status === 401)){
    result.verdict = 'A: the key is NOT recognised by this project (401 everywhere). '
                   + 'The gateway rejected it before Postgres was reached.';
    result.nextStep = 'Confirm the secret key was copied from project "' + urlRef + '" '
                    + '(Supabase > Settings > API > Secret keys) and has not been revoked or rotated. '
                    + 'A key from a different project produces exactly this.';
  } else if(tables.every(p => p.code === '42501')){
    result.verdict = 'B: the key IS accepted (no 401), but Postgres runs the request as a role with '
                   + 'no privileges on ANY table. The request is reaching the database unauthenticated '
                   + '- PostgREST is falling back to the `authenticator` role, which by design holds '
                   + 'no table grants.';
    result.nextStep = 'This is not an RLS problem and not something the header shape can fix. '
                    + 'Either the sb_secret_ key is not being mapped to service_role by this project, '
                    + 'or service_role holds no GRANT on these tables. See the notes returned below.';
    result.notes = [
      'Your browser CAN write to cng_orders using the publishable key, so anon holds grants. '
      + 'Only the server-side role is failing, which narrows it to the key -> role mapping.',
      'Quickest check, no SQL: in Supabase > Settings > API, generate a fresh Secret key, paste it '
      + 'into Vercel, redeploy, and reload this page. If it starts working, the old key was stale.',
      'Second check, no SQL: Supabase > Settings > API > confirm the LEGACY service_role JWT still '
      + 'exists. Putting that value in SUPABASE_SERVICE_ROLE_KEY is a valid fallback - the code '
      + 'already detects a JWT and switches to the apikey+Authorization shape automatically.',
    ];
  } else if(root.ok && tables.some(p => p.ok) && tables.some(p => p.code === '42501')){
    const bad = tables.filter(p => p.code === '42501').map(p => p.label).join(', ');
    result.verdict = 'C: the key works and some tables are readable, but these are not: ' + bad + '.';
    result.nextStep = 'The problem is limited to those specific tables rather than to authentication.';
  } else if(tables.some(p => p.code === '42P01' || p.status === 404)){
    result.verdict = 'The tables do not exist in this project.';
    result.nextStep = 'Run supabase-schema.sql, then whatsapp-migration.sql, in the SQL Editor.';
  } else {
    result.verdict = 'Inconclusive - read the raw probes below.';
    result.nextStep = 'Send this JSON back; it contains no secrets.';
  }

  /* The control probe proves the request really is reaching PostgREST. */
  result.controlProbeMeaning = ghost.code === '42P01'
    ? 'Reached PostgREST: it correctly reported a missing table.'
    : (ghost.status === 401
        ? 'Did not get past the gateway: the key is being rejected outright.'
        : 'Unexpected: status ' + ghost.status + ' ' + (ghost.code || ''));

  return res.status(tables.every(p => p.ok) ? 200 : 500).json(result);
}

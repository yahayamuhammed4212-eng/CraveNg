/* =====================================================================
   GET /api/health
   ---------------------------------------------------------------------
   Read-only. Works out exactly why the server can or cannot read the
   order tables, and reports it in plain words.

   It never returns a key — only its length, first few characters, and
   whether it arrived with stray whitespace or quotes. Safe to open in a
   browser and safe to paste into a chat.
   ===================================================================== */
import { ENV, db, keyKind, keyDiagnostics, missingConfig,
         serviceHeaders, resolveAuthMode } from './_lib.js';

export default async function handler(req, res){
  res.setHeader('Cache-Control','no-store');

  const out = {
    ok: false,
    supabase: {
      urlSet: !!ENV.sbUrl,
      project: ENV.sbUrl ? ENV.sbUrl.replace(/^https?:\/\//,'').split('.')[0] : null,
      key: keyDiagnostics(),
    },
    linkSecretSet: !!ENV.linkSecret,
    whatsapp: {testMode: ENV.testMode, credsSet: !!(ENV.token && ENV.phoneId)},
    missing: missingConfig(),
    headerProbes: [],
    checks: {},
  };

  if(out.missing.length){
    out.error = 'Missing environment variables: ' + out.missing.join(', ');
    return res.status(500).json(out);
  }

  /* Probe each header shape against the real table so we can see which one
     Supabase accepts, and what it says when it refuses. */
  const base = ENV.sbUrl.replace(/\/+$/,'').replace(/\/rest\/v1$/,'') + '/rest/v1/';
  for(const mode of ['apikey','both','auth']){
    const entry = {mode, status:null, ok:false, code:null, message:null};
    try{
      const r = await fetch(base + 'cng_orders?select=id&limit=1', {headers: serviceHeaders(null, mode)});
      const txt = await r.text();
      let body = null; try{ body = JSON.parse(txt); }catch(e){}
      entry.status = r.status;
      entry.ok = r.ok;
      if(!r.ok){
        entry.code = body && body.code;
        entry.message = String((body && (body.message || body.hint)) || txt || '').slice(0,200);
      }
    }catch(e){
      entry.status = 0; entry.message = e.message;
    }
    out.headerProbes.push(entry);
  }

  const working = out.headerProbes.find(p => p.ok);
  out.workingHeaderMode = working ? working.mode : null;

  if(working){
    await resolveAuthMode();
    for(const [name, probe] of [
      ['cng_orders',  () => db.getOrder('__health_check__')],
      ['cng_vendors', () => db.getVendor('__health_check__')],
    ]){
      try{ await probe(); out.checks[name] = 'readable'; }
      catch(e){ out.checks[name] = 'ERROR: ' + e.message; }
    }
    out.ok = Object.values(out.checks).every(v => v === 'readable');
  }

  /* Turn the raw probe results into an instruction. */
  const k = out.supabase.key;
  if(out.ok){
    out.verdict = 'Healthy. Supabase accepts the key using the "' + out.workingHeaderMode +
                  '" header shape, and both order tables are readable.';
  } else if(!k.present){
    out.verdict = 'SUPABASE_SERVICE_ROLE_KEY is empty in this deployment.';
  } else if(k.hadSurroundingWhitespace || k.hadWrappingQuotes || k.containsInnerWhitespace){
    out.verdict = 'The key arrived with stray whitespace or quotes. It has now been trimmed ' +
                  'automatically, but re-paste it cleanly in Vercel to be certain.';
  } else if(/PUBLISHABLE/.test(k.format)){
    out.verdict = 'SUPABASE_SERVICE_ROLE_KEY holds the PUBLISHABLE key. Paste the secret ' +
                  '(service_role) key from Supabase > Settings > API instead.';
  } else if(out.headerProbes.every(p => p.status === 401)){
    out.verdict = 'Supabase rejected the key on every header shape (401). The key does not ' +
                  'belong to this project, or it has been revoked or rotated.';
  } else if(out.headerProbes.some(p => p.code === '42P01' || p.status === 404)){
    /* Checked BEFORE the permission branch: a missing table is the more
       specific finding, and an auth-only probe can also report 42501. */
    out.verdict = 'The cng_orders table was not found. Run supabase-schema.sql and ' +
                  'whatsapp-migration.sql in the SQL Editor.';
  } else if(out.headerProbes.some(p => p.code === '42501')){
    out.verdict = 'Supabase accepted the request but ran it with no role (permission denied). ' +
                  'That is what an unrecognised key looks like: confirm the key belongs to ' +
                  'project "' + (out.supabase.project || '?') + '" and has not been rotated.';
  } else {
    out.verdict = 'Could not read cng_orders. See headerProbes for what Supabase returned.';
  }

  return res.status(out.ok ? 200 : 500).json(out);
}

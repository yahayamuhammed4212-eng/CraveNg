/* =====================================================================
   CraveNG — server-side helpers  (runs ONLY on Vercel, never in a browser)
   ---------------------------------------------------------------------
   Every secret is read from process.env here. Nothing in this file is
   bundled into index.html, so tokens and service keys never reach the
   client. Vercel exposes a variable to the browser only if its name
   begins with NEXT_PUBLIC_ / VITE_ — none of these do, deliberately.
   ===================================================================== */
import crypto from 'crypto';

/* Vercel stores whatever was pasted, including a trailing newline, stray
   spaces, or wrapping quotes. An apikey with any of those is not recognised
   by the Supabase gateway, which then hands the request to PostgREST with
   no role — it runs as `authenticator`, which has no table privileges and
   reports "permission denied for table". The key looks present, so a simple
   emptiness check does not catch it. Clean every value on the way in. */
function envStr(name){
  let v = process.env[name];
  if(v == null) return '';
  v = String(v).trim();
  if(v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))))
    v = v.slice(1, -1).trim();
  return v;
}

/* Read lazily via getters rather than snapshotting at import time. A
   serverless module can be loaded before the runtime has finished
   populating process.env, and a snapshot would freeze the wrong values
   for the life of the warm instance. */
export const ENV = {
  get token()      { return envStr('WHATSAPP_ACCESS_TOKEN'); },
  get phoneId()    { return envStr('WHATSAPP_PHONE_NUMBER_ID'); },
  get wabaId()     { return envStr('WHATSAPP_BUSINESS_ACCOUNT_ID'); },
  get apiVersion() { return envStr('WHATSAPP_API_VERSION') || 'v21.0'; },
  get template()   { return envStr('WHATSAPP_TEMPLATE_NAME'); },
  get templateLang(){ return envStr('WHATSAPP_TEMPLATE_LANG') || 'en'; },
  get testMode()   { return String(envStr('WHATSAPP_TEST_MODE') || 'true').toLowerCase() !== 'false'; },
  get linkSecret() { return envStr('ORDER_LINK_SECRET'); },
  get sbUrl()      { return envStr('SUPABASE_URL'); },
  get sbService()  { return envStr('SUPABASE_SERVICE_ROLE_KEY'); },
  get siteUrl()    { return envStr('PUBLIC_SITE_URL'); },
};

/* Which required settings are missing, so errors name the cause. */
export function missingConfig(){
  const out = [];
  if(!ENV.sbUrl)     out.push('SUPABASE_URL');
  if(!ENV.sbService) out.push('SUPABASE_SERVICE_ROLE_KEY');
  if(!ENV.linkSecret)out.push('ORDER_LINK_SECRET');
  if(!ENV.testMode){
    if(!ENV.token)   out.push('WHATSAPP_ACCESS_TOKEN');
    if(!ENV.phoneId) out.push('WHATSAPP_PHONE_NUMBER_ID');
  }
  return out;
}

/* ---------------------------------------------------------------------
   SIGNED ACTION LINKS
   A vendor link carries an HMAC over (orderId, vendorId, expiry). Editing
   the order id in the URL invalidates the signature, so one vendor can
   never open or act on another vendor's order.
   --------------------------------------------------------------------- */
const b64u = b => Buffer.from(b).toString('base64url');

export function signOrderToken(orderId, vendorId, ttlHours = 72){
  const exp = Date.now() + ttlHours * 3600 * 1000;
  const payload = b64u(JSON.stringify({o:orderId, v:vendorId, e:exp}));
  const sig = crypto.createHmac('sha256', ENV.linkSecret).update(payload).digest('base64url');
  return payload + '.' + sig;
}

export function verifyOrderToken(token){
  if(!token || typeof token !== 'string' || !token.includes('.'))
    return {ok:false, reason:'Malformed link.'};
  const [payload, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', ENV.linkSecret).update(payload).digest('base64url');
  // timing-safe compare
  const a = Buffer.from(sig || ''), b = Buffer.from(expect);
  if(a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return {ok:false, reason:'This link is not valid. It may have been altered.'};
  let data;
  try{ data = JSON.parse(Buffer.from(payload, 'base64url').toString()); }
  catch(e){ return {ok:false, reason:'Malformed link.'}; }
  if(Date.now() > data.e)
    return {ok:false, reason:'This link has expired. Open the order from your dashboard instead.'};
  return {ok:true, orderId:data.o, vendorId:data.v};
}

/* ---------------------------------------------------------------------
   SUPABASE (server side, service role — bypasses RLS, never sent to a browser)
   --------------------------------------------------------------------- */
/* Supabase has two secret-key formats and they must be sent differently.

   Legacy service_role key ("eyJ..." — a JWT):
       apikey: <key>  AND  Authorization: Bearer <key>
       PostgREST reads the role claim out of the JWT -> service_role.

   New secret key ("sb_secret_..." — NOT a JWT):
       apikey: <key>  ONLY.
       If a non-JWT is put in Authorization, PostgREST fails to parse it
       as a token and silently falls back to the anonymous role. That
       role has no GRANT on cng_orders, which surfaces as the Postgres
       error "permission denied for table cng_orders" (42501) — an
       authentication problem wearing a permissions problem's clothes. */
function isJwtKey(k){ return /^ey[A-Za-z0-9_-]/.test(String(k || '')); }

/* Describes the key format without ever revealing the key itself. */
export function keyKind(){
  const k = ENV.sbService || '';
  if(!k) return 'missing';
  if(isJwtKey(k)) return 'legacy JWT';
  if(k.startsWith('sb_secret_')) return 'new secret';
  if(k.startsWith('sb_publishable_')) return 'PUBLISHABLE (wrong key — cannot write)';
  return 'unrecognised';
}

export function serviceHeaders(extra, mode){
  const m = mode || (modeStillValid() ? SB_MODE.chosen : null) || (isJwtKey(ENV.sbService) ? 'both' : 'apikey');
  const h = {apikey: ENV.sbService, 'Content-Type': 'application/json'};
  if(m === 'both' || m === 'auth') h.Authorization = 'Bearer ' + ENV.sbService;
  if(m === 'auth') delete h.apikey;
  return Object.assign(h, extra || {});
}

/* Rather than assume which header shape this project wants, try them once
   and keep whichever the server accepts. Costs one extra request per cold
   start and removes a whole class of guesswork. */
export const SB_MODE = {chosen:null, tried:null, forKey:null};

/* Forget a cached decision if the key itself changed. */
function modeStillValid(){
  return SB_MODE.chosen && SB_MODE.forKey === ENV.sbService;
}

export async function resolveAuthMode(){
  if(modeStillValid()) return SB_MODE.chosen;
  SB_MODE.chosen = null;
  const base = ENV.sbUrl.replace(/\/+$/,'').replace(/\/rest\/v1$/,'') + '/rest/v1/';
  const order = isJwtKey(ENV.sbService) ? ['both','apikey','auth'] : ['apikey','both','auth'];
  const tried = [];
  for(const m of order){
    try{
      const r = await fetch(base + 'cng_orders?select=id&limit=1', {headers: serviceHeaders(null, m)});
      const txt = await r.text();
      tried.push({mode:m, status:r.status, ok:r.ok});
      if(r.ok){ SB_MODE.chosen = m; SB_MODE.forKey = ENV.sbService; SB_MODE.tried = tried; return m; }
    }catch(e){
      tried.push({mode:m, status:0, ok:false, error:e.message});
    }
  }
  SB_MODE.tried = tried;
  return null;                       // none worked; callers surface the diagnosis
}

/* Describes the key WITHOUT revealing it, so a bad value can be spotted. */
export function keyDiagnostics(){
  const raw = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const k = ENV.sbService;
  return {
    present: !!k,
    length: k.length,
    prefix: k ? k.slice(0, 11) + '\u2026' : '',
    format: keyKind(),
    hadSurroundingWhitespace: raw != null && String(raw) !== String(raw).trim(),
    hadWrappingQuotes: raw != null && /^\s*["'][\s\S]*["']\s*$/.test(String(raw)),
    containsInnerWhitespace: /\s/.test(k),
  };
}

async function sb(path, opts = {}){
  await resolveAuthMode();
  const url = ENV.sbUrl.replace(/\/+$/,'').replace(/\/rest\/v1$/,'') + '/rest/v1/' + path;
  const r = await fetch(url, {
    ...opts,
    headers: serviceHeaders(opts.headers),
  });
  const text = await r.text();
  let body = null;
  if(text){ try{ body = JSON.parse(text); }catch(e){ body = {message:text}; } }
  if(!r.ok){
    let msg = (body && (body.message || body.hint)) || ('Supabase HTTP ' + r.status);
    const code = body && body.code;
    if(code === '42501' || /permission denied/i.test(msg)){
      const d = keyDiagnostics();
      msg = 'permission denied — Supabase did not recognise the key, so the request ran with no role. '
          + 'Key: ' + d.format + ', length ' + d.length
          + (d.hadSurroundingWhitespace ? ', HAS STRAY WHITESPACE/NEWLINE' : '')
          + (d.hadWrappingQuotes ? ', IS WRAPPED IN QUOTES' : '')
          + (d.containsInnerWhitespace ? ', CONTAINS A SPACE OR LINE BREAK' : '')
          + '. Open /api/health for the full diagnosis.';
    }
    const err = new Error(msg);
    err.status = r.status; err.code = code;
    throw err;
  }
  return body;
}

export const db = {
  async getOrder(id){
    const rows = await sb('cng_orders?id=eq.' + encodeURIComponent(id) + '&select=*');
    return rows && rows[0] ? rows[0] : null;
  },
  async getVendor(id){
    const rows = await sb('cng_vendors?id=eq.' + encodeURIComponent(id) + '&select=*');
    return rows && rows[0] ? rows[0] : null;
  },
  async patchOrder(id, patch){
    return sb('cng_orders?id=eq.' + encodeURIComponent(id),
      {method:'PATCH', headers:{Prefer:'return=minimal'}, body: JSON.stringify(patch)});
  },
  async logNotification(row){
    return sb('cng_notifications',
      {method:'POST', headers:{Prefer:'return=minimal'}, body: JSON.stringify([row])});
  },
};

/* ---------------------------------------------------------------------
   PHONE NUMBERS
   WhatsApp needs E.164 without the leading +. Nigerian numbers are
   usually stored as 080…, which must become 23480….
   --------------------------------------------------------------------- */
export function toE164(raw, countryCode = '234'){
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if(d.startsWith('+')) d = d.slice(1);
  if(d.startsWith('00')) d = d.slice(2);
  if(d.startsWith('0')) d = countryCode + d.slice(1);        // 0803… -> 234803…
  else if(!d.startsWith(countryCode) && d.length <= 10) d = countryCode + d;
  return d;
}

/* ---------------------------------------------------------------------
   MESSAGE BODY
   --------------------------------------------------------------------- */
export function buildOrderMessage(order, vendor, link){
  const naira = n => '\u20A6' + Number(n || 0).toLocaleString('en-NG');
  const items = (order.items || [])
    .map(i => `\u2022 ${i.name} \u00D7 ${i.qty}`).join('\n');
  const when = order.mode === 'pre' && order.scheduled_date
    ? `Scheduled: ${order.scheduled_date} at ${order.scheduled_time || ''}`
    : 'Deliver as soon as possible';

  return [
    `\u{1F514} NEW ORDER \u2014 ${order.id}`,
    ``,
    `Kitchen: ${vendor ? vendor.name : order.vendor_name}`,
    `Customer: ${order.customer_name}`,
    `Phone: ${order.customer_phone}`,
    ``,
    `Items:`,
    items || '\u2022 (none)',
    ``,
    `Total: ${naira(order.total)}`,
    `Payment: ${order.pay_method === 'pod' ? 'Pay on delivery' : order.pay_method} (${order.pay_status})`,
    ``,
    `Deliver to: ${order.address}${order.landmark ? ' (' + order.landmark + ')' : ''}`,
    `Area: ${order.vendor_area || ''}`,
    when,
    order.notes ? `Notes: ${order.notes}` : '',
    ``,
    `Review and accept this order:`,
    link,
  ].filter(l => l !== '').join('\n');
}

/* ---------------------------------------------------------------------
   WHATSAPP CLOUD API
   Returns {ok, id, error, testMode}. Never throws: a failed notification
   must not be allowed to fail a customer's order.
   --------------------------------------------------------------------- */
export async function sendWhatsApp(toRaw, text, opts = {}){
  const to = toE164(toRaw);
  if(!to) return {ok:false, error:'Vendor has no WhatsApp number on file.'};

  if(ENV.testMode){
    console.log('\n[CraveNG][WHATSAPP TEST MODE] would send to +' + to + ':\n' + text + '\n');
    return {ok:true, id:'test-' + Date.now(), testMode:true};
  }
  if(!ENV.token || !ENV.phoneId)
    return {ok:false, error:'WhatsApp credentials are not configured on the server.'};

  const url = `https://graph.facebook.com/${ENV.apiVersion}/${ENV.phoneId}/messages`;
  /* Outside a 24-hour customer service window Meta requires an approved
     template. If WHATSAPP_TEMPLATE_NAME is set we use it; otherwise we
     send plain text, which works while testing with your own number. */
  const payload = ENV.template
    ? {messaging_product:'whatsapp', to, type:'template',
       template:{name:ENV.template, language:{code:ENV.templateLang},
         components:[{type:'body', parameters:(opts.templateParams || [text]).map(t => ({type:'text', text:String(t).slice(0,1024)}))}]}}
    : {messaging_product:'whatsapp', to, type:'text',
       text:{preview_url:false, body:text.slice(0, 4096)}};

  try{
    const r = await fetch(url, {
      method:'POST',
      headers:{Authorization:'Bearer ' + ENV.token, 'Content-Type':'application/json'},
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({}));
    if(!r.ok){
      const m = body && body.error ? (body.error.message || JSON.stringify(body.error)) : ('HTTP ' + r.status);
      return {ok:false, error:m, status:r.status};
    }
    return {ok:true, id: body.messages && body.messages[0] && body.messages[0].id};
  }catch(e){
    return {ok:false, error:e.message};
  }
}

export function siteOrigin(req){
  if(ENV.siteUrl) return ENV.siteUrl.replace(/\/+$/,'');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

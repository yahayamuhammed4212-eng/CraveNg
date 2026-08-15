/* =====================================================================
   GET  /api/order-action?token=...            -> vendor sees the order
   POST /api/order-action  {token, action}     -> accept / reject / advance
   ---------------------------------------------------------------------
   Authorisation comes from the HMAC in the token, which binds the order
   id to the vendor id. Changing the order id in the URL breaks the
   signature, so a vendor can only ever see and act on their own order.

   This page is rendered on the server and is separate from the website
   itself â€” the existing site design, routes and files are untouched.
   ===================================================================== */
import { db, verifyOrderToken, missingConfig, siteOrigin } from './_lib.js';

/* Server statuses map onto the app's existing FLOW values so nothing in
   the customer tracker or vendor dashboard has to change. */
const NEXT_ACTION = {
  accept:   {to:'Accepted',        stamp:'accepted_at'},
  reject:   {to:'Rejected',        stamp:'rejected_at'},
  preparing:{to:'Preparing',       stamp:'preparing_at'},
  ready:    {to:'Ready',           stamp:'ready_at'},
  dispatch: {to:'Out for delivery',stamp:'out_for_delivery_at'},
  delivered:{to:'Delivered',       stamp:'delivered_at'},
};

const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const naira = n => '\u20A6' + Number(n || 0).toLocaleString('en-NG');

/* Matches the site's existing dark palette so a vendor does not feel
   thrown into a different product. No site files are modified. */
function page(title, inner){
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0A0806"><title>${esc(title)} Â· CraveNG</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,900&family=Plus+Jakarta+Sans:wght@400;600;700&family=DM+Mono&display=swap" rel="stylesheet">
<style>
:root{--bg:#0A0806;--surface:#1A1310;--surface2:#231A14;--line:rgba(226,104,15,.18);
--orange:#E2680F;--orangeHi:#FF8330;--gold:#F2B33D;--green:#3E9B63;--red:#D2483B;
--text:#FBF5EC;--soft:#BEAF9F;--faint:#8A7B6C;--mono:'DM Mono',ui-monospace,monospace}
*{box-sizing:border-box}
body{margin:0;padding:26px 16px;color:var(--text);font-family:'Plus Jakarta Sans',system-ui,sans-serif;
 background:radial-gradient(900px 600px at 15% -10%,rgba(226,104,15,.13),transparent 60%),var(--bg);line-height:1.55}
.wrap{max-width:560px;margin:0 auto}
.card{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:24px;margin-bottom:16px;
 box-shadow:0 12px 30px rgba(0,0,0,.5)}
h1{font-family:Fraunces,Georgia,serif;font-weight:900;font-size:26px;margin:0 0 4px;letter-spacing:-.02em}
h2{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:18px;margin:0 0 14px}
.mono{font-family:var(--mono)}
.muted{color:var(--soft);font-size:14px}
.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;font-size:14.5px;color:var(--soft)}
.row b{color:var(--text);text-align:right}
.tot{margin-top:10px;padding-top:12px;border-top:1px dashed rgba(226,104,15,.32);
 font-family:Fraunces,serif;font-size:20px;font-weight:700;color:var(--text)}
.items{margin:6px 0 14px}
.item{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:14.5px}
.item .q{font-family:var(--mono);color:var(--gold)}
.item .n{flex:1}
.pill{display:inline-block;font-family:var(--mono);font-size:10.5px;letter-spacing:.11em;text-transform:uppercase;
 padding:5px 11px;border-radius:999px;border:1px solid transparent}
.p-new{background:rgba(242,179,61,.14);color:var(--gold);border-color:rgba(242,179,61,.3)}
.p-ok{background:rgba(62,155,99,.14);color:#6FCB93;border-color:rgba(62,155,99,.3)}
.p-no{background:rgba(210,72,59,.14);color:#EA7A6E;border-color:rgba(210,72,59,.3)}
.btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
button{flex:1;min-width:140px;border:none;border-radius:999px;padding:16px 22px;font-family:inherit;
 font-weight:700;font-size:15px;cursor:pointer;transition:transform .15s ease}
button:active{transform:translateY(1px)}
.accept{background:linear-gradient(150deg,var(--orangeHi),var(--orange));color:#fff;box-shadow:0 8px 22px rgba(226,104,15,.34)}
.reject{background:transparent;color:var(--text);border:1.4px solid rgba(210,72,59,.5)}
.next{background:var(--surface2);color:var(--text);border:1px solid var(--line)}
.note{border-radius:12px;padding:12px 14px;font-size:13.5px;margin-bottom:14px}
.n-info{background:rgba(242,179,61,.12);color:var(--gold);border:1px solid rgba(242,179,61,.26)}
.n-bad{background:rgba(210,72,59,.14);color:#EA7A6E;border:1px solid rgba(210,72,59,.3)}
.n-ok{background:rgba(62,155,99,.14);color:#6FCB93;border:1px solid rgba(62,155,99,.3)}
a.link{color:var(--gold);font-size:13.5px}
</style></head><body><div class="wrap">${inner}</div></body></html>`;
}

function errorPage(msg, code){
  return page('Order', `<div class="card">
    <h1>Cannot open this order</h1>
    <div class="note n-bad" style="margin-top:14px">${esc(msg)}</div>
    <p class="muted">If you were sent this link by CraveNG, open your vendor dashboard instead and find the order there.</p>
  </div>`);
}

function orderPage(order, vendor, token, flash){
  const done = ['Delivered','Rejected','Cancelled'].includes(order.status);
  const pill = order.status === 'Pending' ? 'p-new'
             : (order.status === 'Rejected' || order.status === 'Cancelled') ? 'p-no' : 'p-ok';

  // which buttons make sense from here
  let actions = '';
  if(order.status === 'Pending'){
    actions = `<button class="accept" data-a="accept">Accept order</button>
               <button class="reject" data-a="reject">Reject order</button>`;
  } else if(!done){
    const nxt = {Accepted:['preparing','Mark preparing'], Preparing:['ready','Mark ready'],
                 Ready:['dispatch','Out for delivery'], 'Out for delivery':['delivered','Mark delivered']}[order.status];
    if(nxt) actions = `<button class="next" data-a="${nxt[0]}">${nxt[1]}</button>`;
  }

  const items = (order.items || []).map(i =>
    `<div class="item"><span class="q">${i.qty}\u00D7</span><span class="n">${esc(i.name)}</span>
     <span class="mono">${naira((i.price||0)*(i.qty||0))}</span></div>`).join('');

  return page('Order ' + order.id, `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div><h1 class="mono" style="font-size:22px">${esc(order.id)}</h1>
        <div class="muted">${esc(vendor ? vendor.name : order.vendor_name || '')}</div></div>
      <span class="pill ${pill}">${esc(order.status)}</span>
    </div>
    ${flash ? `<div class="note ${flash.ok ? 'n-ok' : 'n-bad'}" style="margin-top:16px">${esc(flash.msg)}</div>` : ''}
  </div>

  <div class="card">
    <h2>Items</h2>
    <div class="items">${items || '<div class="muted">No items.</div>'}</div>
    <div class="row"><span>Subtotal</span><b>${naira(order.subtotal)}</b></div>
    <div class="row"><span>Delivery</span><b>${naira(order.delivery_fee)}</b></div>
    <div class="row tot"><span>Total</span><b>${naira(order.total)}</b></div>
  </div>

  <div class="card">
    <h2>Customer</h2>
    <div class="row"><span>Name</span><b>${esc(order.customer_name)}</b></div>
    <div class="row"><span>Phone</span><b class="mono">${esc(order.customer_phone)}</b></div>
    <div class="row"><span>Address</span><b>${esc(order.address)}</b></div>
    ${order.landmark ? `<div class="row"><span>Landmark</span><b>${esc(order.landmark)}</b></div>` : ''}
    <div class="row"><span>Type</span><b>${order.mode === 'pre'
      ? 'Pre-order \u00B7 ' + esc(order.scheduled_date || '') + ' ' + esc(order.scheduled_time || '')
      : 'Deliver now'}</b></div>
    <div class="row"><span>Payment</span><b>${esc(order.pay_method === 'pod' ? 'Pay on delivery' : order.pay_method)} \u00B7 ${esc(order.pay_status || '')}</b></div>
    <div class="row"><span>Placed</span><b>${esc(new Date(order.placed_at || Date.now()).toLocaleString('en-NG'))}</b></div>
    ${order.notes ? `<div class="note n-info" style="margin-top:12px">\u{1F4DD} ${esc(order.notes)}</div>` : ''}
  </div>

  ${actions ? `<div class="card"><h2>Update this order</h2><div class="btns">${actions}</div></div>`
            : `<div class="card"><div class="muted">This order is ${esc(order.status.toLowerCase())}. No further action is needed here.</div></div>`}

  <script>
    var TOKEN = ${JSON.stringify(token)};
    document.querySelectorAll('button[data-a]').forEach(function(b){
      b.addEventListener('click', function(){
        document.querySelectorAll('button').forEach(function(x){ x.disabled = true; });
        b.textContent = 'Working\\u2026';
        fetch(location.pathname, {method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({token:TOKEN, action:b.getAttribute('data-a')})})
          .then(function(r){ return r.text(); })
          .then(function(html){ document.open(); document.write(html); document.close(); })
          .catch(function(e){ alert('Could not update the order: ' + e.message); location.reload(); });
      });
    });
  </script>`);
}

export default async function handler(req, res){
  const missing = missingConfig();
  if(missing.length){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.status(500).send(errorPage('The server is not configured yet. Missing: ' + missing.join(', ')));
  }

  const isPost = req.method === 'POST';
  let body = req.body;
  if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(e){ body = {}; } }
  const token = (isPost ? (body && body.token) : (req.query && req.query.token)) || '';

  const check = verifyOrderToken(token);
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  if(!check.ok) return res.status(403).send(errorPage(check.reason));

  let order;
  try{ order = await db.getOrder(check.orderId); }
  catch(e){ return res.status(502).send(errorPage('Could not load the order: ' + e.message)); }
  if(!order) return res.status(404).send(errorPage('That order no longer exists.'));

  /* The token names the vendor. Even with a valid signature, refuse if the
     order has since moved to another kitchen. */
  if(order.vendor_id !== check.vendorId)
    return res.status(403).send(errorPage('This order does not belong to your kitchen.'));

  const vendor = await db.getVendor(order.vendor_id).catch(() => null);

  if(!isPost) return res.status(200).send(orderPage(order, vendor, token, null));

  // ---- POST: apply the action ----
  const action = body && body.action;
  const step = NEXT_ACTION[action];
  if(!step) return res.status(400).send(orderPage(order, vendor, token,
    {ok:false, msg:'Unknown action.'}));

  if(['Delivered','Rejected','Cancelled'].includes(order.status))
    return res.status(409).send(orderPage(order, vendor, token,
      {ok:false, msg:'This order is already ' + order.status.toLowerCase() + ' and cannot be changed.'}));

  if(action === 'accept' && order.status !== 'Pending')
    return res.status(409).send(orderPage(order, vendor, token,
      {ok:false, msg:'This order was already accepted.'}));

  const now = new Date().toISOString();
  const history = Array.isArray(order.history) ? order.history.slice() : [];
  history.push({status: step.to, at: now});

  try{
    await db.patchOrder(order.id, {status: step.to, history, [step.stamp]: now});
  }catch(e){
    return res.status(502).send(orderPage(order, vendor, token,
      {ok:false, msg:'Could not save the change: ' + e.message}));
  }

  const fresh = Object.assign({}, order, {status: step.to, history, [step.stamp]: now});
  const msg = action === 'accept' ? 'Order accepted. The customer can see this immediately.'
            : action === 'reject' ? 'Order rejected. The customer has been told.'
            : 'Order marked ' + step.to.toLowerCase() + '.';
  return res.status(200).send(orderPage(fresh, vendor, token, {ok:true, msg}));
                   }

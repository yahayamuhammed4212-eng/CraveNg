/* =====================================================================
   POST /api/notify-order   { orderId }
   ---------------------------------------------------------------------
   Called by the website AFTER the order has already been saved. The
   order is never created here, so a WhatsApp failure can never lose a
   customer's order â€” the worst case is a notification marked "failed"
   that the vendor can retry from their dashboard.

   Multi-vendor note: CraveNG carts hold one kitchen at a time (enforced
   in addItem), so one order = one vendor = one notification. If carts
   ever span kitchens, the checkout should split them into separate
   orders and call this route once per order id â€” no change needed here.
   ===================================================================== */
import { db, ENV, missingConfig, signOrderToken, buildOrderMessage,
         sendWhatsApp, siteOrigin } from './_lib.js';

export default async function handler(req, res){
  if(req.method !== 'POST'){
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ok:false, error:'Use POST.'});
  }

  const missing = missingConfig();
  if(missing.length)
    return res.status(500).json({ok:false, error:'Server not configured. Missing: ' + missing.join(', ')});

  let body = req.body;
  if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(e){ body = {}; } }
  const orderId = body && body.orderId;
  if(!orderId) return res.status(400).json({ok:false, error:'orderId is required.'});

  let order;
  try{
    order = await db.getOrder(orderId);
  }catch(e){
    return res.status(502).json({ok:false, error:'Could not read the order: ' + e.message});
  }
  if(!order) return res.status(404).json({ok:false, error:'No such order.'});

  /* Idempotent: never notify the same order twice. Protects against a
     double-tapped checkout or a retried request. */
  if(order.whatsapp_notification_status === 'sent')
    return res.status(200).json({ok:true, already:true, status:'sent',
      messageId: order.whatsapp_message_id});

  const vendor = await db.getVendor(order.vendor_id).catch(() => null);
  const to = vendor && (vendor.whatsapp || vendor.phone);

  const token = signOrderToken(order.id, order.vendor_id);
  const link = `${siteOrigin(req)}/api/order-action?token=${encodeURIComponent(token)}`;
  const text = buildOrderMessage(order, vendor, link);

  let result;
  if(!to){
    result = {ok:false, error:'Vendor has no WhatsApp number on file.'};
  } else {
    result = await sendWhatsApp(to, text);
  }

  const status = result.ok ? 'sent' : 'failed';
  const patch = {
    whatsapp_notification_status: status,
    whatsapp_message_id: result.id || null,
    whatsapp_error: result.ok ? null : String(result.error || '').slice(0, 400),
    whatsapp_attempts: (order.whatsapp_attempts || 0) + 1,
    whatsapp_last_try_at: new Date().toISOString(),
  };
  // Bookkeeping must not mask a successful send.
  await db.patchOrder(order.id, patch).catch(e =>
    console.error('[CraveNG] could not record notification status:', e.message));
  await db.logNotification({
    order_id: order.id, vendor_id: order.vendor_id, recipient: to || null,
    template: ENV.template || 'plain_text', body: text,
    status, provider_id: result.id || null,
    error: result.ok ? null : String(result.error || '').slice(0, 400),
    test_mode: !!result.testMode,
  }).catch(() => {});

  return res.status(200).json({
    ok: result.ok,
    status,
    testMode: !!result.testMode,
    messageId: result.id || null,
    error: result.ok ? null : result.error,
    // returned in test mode so you can read exactly what would have been sent
    preview: ENV.testMode ? text : undefined,
    link: ENV.testMode ? link : undefined,
  });
                      }

// PayFast: betaalvorm-handtekening, ITN-verifikasie en intekening-kansellasie.
// Sleutels kom uit Cloudflare se geheime instellings (nooit in die kode).
import { createHash } from 'node:crypto';

export const PLANS = {
  monthly: { item: 'Stroom Premium (maandeliks)', recurring: '59.00', frequency: '3', trialDays: 7, allowed: ['0.00', '59.00'] },
  annual:  { item: 'Stroom Premium (jaarliks)',   recurring: '590.00', frequency: '6', trialDays: 0, allowed: ['590.00'] },
};

// Volgorde waarin PayFast die velde in die handtekening verwag
const FIELD_ORDER = ['merchant_id', 'merchant_key', 'return_url', 'cancel_url', 'notify_url', 'name_first', 'name_last',
  'email_address', 'cell_number', 'm_payment_id', 'amount', 'item_name', 'item_description',
  'custom_int1', 'custom_int2', 'custom_int3', 'custom_int4', 'custom_int5',
  'custom_str1', 'custom_str2', 'custom_str3', 'custom_str4', 'custom_str5',
  'email_confirmation', 'confirmation_address', 'payment_method',
  'subscription_type', 'billing_date', 'recurring_amount', 'frequency', 'cycles'];

export const md5 = (s) => createHash('md5').update(s).digest('hex');

// Soos PHP se urlencode(): spasie -> +, res buite A-Z a-z 0-9 - _ . word %XX (hoofletters)
export function pfEncode(v) {
  return encodeURIComponent(String(v).trim())
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function config(env) {
  if (!env.PAYFAST_MERCHANT_ID || !env.PAYFAST_MERCHANT_KEY || !env.PAYFAST_PASSPHRASE) return null;
  const live = env.PAYFAST_MODE === 'live';
  return {
    live, merchantId: env.PAYFAST_MERCHANT_ID, merchantKey: env.PAYFAST_MERCHANT_KEY, passphrase: env.PAYFAST_PASSPHRASE,
    process: live ? 'https://www.payfast.co.za/eng/process' : 'https://sandbox.payfast.co.za/eng/process',
    validate: live ? 'https://www.payfast.co.za/eng/query/validate' : 'https://sandbox.payfast.co.za/eng/query/validate',
    api: 'https://api.payfast.co.za', apiQuery: live ? '' : '?testing=true',
  };
}

// Handtekening vir die betaalvorm (leë waardes uitgelaat, vaste veldvolgorde)
export function formSignature(fields, passphrase) {
  const keys = Object.keys(fields).filter((k) => k !== 'signature' && String(fields[k]).trim() !== '')
    .sort((a, b) => (FIELD_ORDER.indexOf(a) + 1 || 999) - (FIELD_ORDER.indexOf(b) + 1 || 999));
  const str = keys.map((k) => `${k}=${pfEncode(fields[k])}`).join('&') + `&passphrase=${pfEncode(passphrase)}`;
  return md5(str);
}

// Datum in Suid-Afrikaanse tyd (UTC+2) as YYYY-MM-DD, met 'n aantal dae bygevoeg
export function saDate(daysAhead = 0, now = Date.now()) {
  return new Date(now + 2 * 3600e3 + daysAhead * 86400e3).toISOString().slice(0, 10);
}

export function buildCheckout({ cfg, user, orderId, planKey, origin, now }) {
  const p = PLANS[planKey];
  const [first, ...rest] = String(user.name || user.email.split('@')[0]).split(' ');
  const fields = {
    merchant_id: cfg.merchantId, merchant_key: cfg.merchantKey,
    return_url: `${origin}/rekening.html?betaling=terug`,
    cancel_url: `${origin}/kies-plan.html?betaling=gekanselleer`,
    notify_url: `${origin}/api/payfast-itn`,
    name_first: first, name_last: rest.join(' '), email_address: user.email,
    m_payment_id: orderId,
    amount: p.trialDays ? '0.00' : p.recurring,
    item_name: p.item,
    subscription_type: '1',
    billing_date: saDate(p.trialDays, now),
    recurring_amount: p.recurring, frequency: p.frequency, cycles: '0',
  };
  fields.signature = formSignature(fields, cfg.passphrase);
  return { action: cfg.process, fields };
}

// ITN: kontroleer handtekening uit die ontvangde veldvolgorde
export function itnParams(bodyText) { return [...new URLSearchParams(bodyText).entries()]; }

export function itnParamString(pairs) {
  return pairs.filter(([k]) => k !== 'signature').map(([k, v]) => `${k}=${pfEncode(v)}`).join('&');
}

export function itnSignatureOk(pairs, passphrase) {
  const sig = (pairs.find(([k]) => k === 'signature') || [])[1];
  if (!sig) return false;
  return md5(itnParamString(pairs) + `&passphrase=${pfEncode(passphrase)}`) === sig;
}

// Bevestig by PayFast self dat die ITN eg is (verwag antwoord "VALID")
export async function confirmWithPayfast(cfg, pairs, fetchImpl = fetch) {
  const res = await fetchImpl(cfg.validate, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: itnParamString(pairs) });
  return (await res.text()).trim() === 'VALID';
}

// Verwerk een ITN. Gee { status, note } terug; verander die databasis slegs by 'n geldige, bevestigde betaling.
export async function processItn({ db, cfg, bodyText, fetchImpl }) {
  const pairs = itnParams(bodyText);
  const f = Object.fromEntries(pairs);
  if (!itnSignatureOk(pairs, cfg.passphrase)) return { status: 400, note: 'handtekening' };
  if (f.merchant_id !== cfg.merchantId) return { status: 400, note: 'handelaar' };
  const order = await db.prepare('SELECT m_payment_id, user_id, plan, status FROM orders WHERE m_payment_id = ?').bind(f.m_payment_id || '').first();
  if (!order) return { status: 400, note: 'bestelling' };
  if (!(await confirmWithPayfast(cfg, pairs, fetchImpl))) return { status: 400, note: 'bevestiging' };

  const plan = PLANS[order.plan];
  const gross = Number(f.amount_gross).toFixed(2);
  if (f.payment_status === 'COMPLETE') {
    if (!plan || !plan.allowed.includes(gross)) return { status: 400, note: 'bedrag' };
    await db.prepare("UPDATE users SET plan = 'svod', plan_period = ?, pf_token = ? WHERE id = ?").bind(order.plan, f.token || null, order.user_id).run();
    await db.prepare("UPDATE orders SET status = 'complete' WHERE m_payment_id = ?").bind(order.m_payment_id).run();
    return { status: 200, note: 'geaktiveer' };
  }
  if (f.payment_status === 'CANCELLED') {
    await db.prepare("UPDATE users SET plan = 'avod', plan_period = NULL, pf_token = NULL WHERE id = ? AND plan = 'svod'").bind(order.user_id).run();
    await db.prepare("UPDATE orders SET status = 'cancelled' WHERE m_payment_id = ?").bind(order.m_payment_id).run();
    return { status: 200, note: 'gekanselleer' };
  }
  return { status: 200, note: 'geen verandering' };
}

// Kanselleer 'n intekening by PayFast se API
export async function cancelSubscription(cfg, token, fetchImpl = fetch, now = Date.now()) {
  const timestamp = new Date(now + 2 * 3600e3).toISOString().slice(0, 19);
  const headers = { 'merchant-id': cfg.merchantId, version: 'v1', timestamp };
  const sigStr = Object.entries({ ...headers, passphrase: cfg.passphrase }).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${pfEncode(v)}`).join('&');
  const res = await fetchImpl(`${cfg.api}/subscriptions/${encodeURIComponent(token)}/cancel${cfg.apiQuery}`,
    { method: 'PUT', headers: { ...headers, signature: md5(sigStr) } });
  return res.ok;
}

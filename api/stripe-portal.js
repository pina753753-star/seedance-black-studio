const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, endpoint: '/api/stripe-portal' });
  }
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  if (!secretKey) return res.status(500).json({ ok: false, error: 'Missing STRIPE_SECRET_KEY' });
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const { data: { user }, error: authError } = await db.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ ok: false, error: 'Invalid token' });
  const stripe = new Stripe(secretKey);
  try {
    const { data: profile } = await db.from('profiles').select('stripe_customer_id,email').eq('id', user.id).maybeSingle();
    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const email = user.email || profile?.email || '';
      if (!email) return res.status(400).json({ ok: false, error: 'No email found' });
      const customers = await stripe.customers.list({ email, limit: 1 });
      if (!customers.data.length) return res.status(404).json({ ok: false, error: 'no_customer' });
      customerId = customers.data[0].id;
      await db.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id);
    }
    const origin = (req.headers.origin || 'https://flowvid-studio.vercel.app').replace(/\/$/, '');
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: origin + '/profile.html'
    });
    return res.status(200).json({ ok: true, url: session.url });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};

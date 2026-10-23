'use strict';
// Temporary auth-only diagnostic. Never merge to main.
const EXPIRES_AT = Date.parse('2026-10-23T05:20:00Z');
const BRANCH = 'verify/pina-worker-auth-20261023';
const ENDPOINT = 'https://seedance-black-studio-production.up.railway.app/watermark';
function createHandler(deps = {}) {
  let attempted = false;
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const env = deps.env || process.env;
    const now = deps.now || Date.now;
    const reply = (status, error) => res.status(status).json({ok:false,error});
    if (env.VERCEL_ENV !== 'preview' || env.VERCEL_GIT_COMMIT_REF !== BRANCH || now() >= EXPIRES_AT) return reply(410,'PROBE_DISABLED');
    if (req.method !== 'POST') return reply(405,'METHOD_NOT_ALLOWED');
    if (req.headers?.origin !== `https://${req.headers?.host}`) return reply(403,'ORIGIN_REJECTED');
    if (req.body && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) return reply(400,'EMPTY_BODY_REQUIRED');
    try {
      const requireAuth = deps.requireAuth || require('./_lib/confirmed-auth.js').requireConfirmedAuth;
      const auth = await requireAuth(req);
      if (!auth.ok) return reply(401,'UNAUTHORIZED');
      const adminEmail = String(env.ADMIN_EMAIL || 'hinaran53@gmail.com').trim().toLowerCase();
      if (!auth.user?.id || String(auth.user.email || '').toLowerCase() !== adminEmail) return reply(403,'ADMIN_REQUIRED');
      const {data,error} = await auth.supabase.from('profiles').select('id,email,role').eq('id',auth.user.id).maybeSingle();
      if (error || data?.id !== auth.user.id || data?.role !== 'admin' || String(data.email || '').toLowerCase() !== adminEmail) return reply(403,'ADMIN_REQUIRED');
      if (now() >= EXPIRES_AT) return reply(410,'PROBE_DISABLED');
      if (attempted) return reply(409,'ALREADY_ATTEMPTED');
      if (!/^[a-f0-9]{64}$/.test(env.WATERMARK_SECRET || '')) return reply(503,'KEY_NOT_CONFIGURED');
      attempted = true;
      const controller = new AbortController();
      const timer = setTimeout(()=>controller.abort(),10000);
      try {
        const upstream = await (deps.fetch || fetch)(ENDPOINT, {
          method:'POST',redirect:'error',signal:controller.signal,
          headers:{Authorization:`Bearer ${env.WATERMARK_SECRET}`,'Content-Type':'application/json'},body:'{}'
        });
        if (!upstream.body) return reply(502,'UNEXPECTED_RESPONSE');
        const reader = upstream.body.getReader(); let size=0; const chunks=[];
        try { while(true) { const {done,value}=await reader.read(); if(done) break; size+=value.byteLength; if(size>8192){await reader.cancel(); return reply(502,'RESPONSE_TOO_LARGE');} chunks.push(Buffer.from(value)); } } finally { reader.releaseLock(); }
        let body; try {body=JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {return reply(502,'UNEXPECTED_RESPONSE');}
        if(upstream.status!==400 || body?.ok!==false || body?.error!=='videoUrl is required') return reply(502,'AUTH_PROBE_FAILED');
        return res.status(200).json({ok:true,upstreamStatus:400});
      } finally {clearTimeout(timer);}
    } catch { return reply(502,'PROBE_FAILED_DO_NOT_RETRY'); }
  };
}
module.exports=createHandler();
module.exports._test={createHandler,EXPIRES_AT,BRANCH};

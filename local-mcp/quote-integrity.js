'use strict';
// Local injectable signing primitive only. No key generation, env reads or IO.
const { createHmac, timingSafeEqual } = require('node:crypto');
function payload(q) {
  return JSON.stringify(['pina-quote-v1',q.id,q.userId,q.expiresAt,q.input.prompt,q.input.model,q.input.mode,q.input.duration,q.input.resolution,q.input.aspect_ratio,q.credits,q.watermarkRequired]);
}
function createQuoteIntegrity(key) {
  if (!Buffer.isBuffer(key) || key.length < 32) throw new Error('Injected signing material required');
  const material=Buffer.from(key);
  const sign=q=>createHmac('sha256',material).update(payload(q)).digest('hex');
  return {sign, verify(q){
    if(typeof q.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(q.fingerprint))return false;
    return timingSafeEqual(Buffer.from(sign(q),'hex'),Buffer.from(q.fingerprint,'hex'));
  }};
}
module.exports={createQuoteIntegrity};

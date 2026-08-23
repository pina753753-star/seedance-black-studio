'use strict';

const HASH_RE = /^[0-9a-f]{64}$/i;

function serviceClient() {
  const { createClient } = require('@supabase/supabase-js');

  const url =
    process.env.SUPABASE_URL ||
    'https://jflpjsdjmlkmkqfahxwy.supabase.co';

  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE;

  if (!url || !serviceKey) return null;

  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

function normalizeHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  if (!hash) return '';
  return HASH_RE.test(hash) ? hash : null;
}

async function validateHash(db, codeHash) {
  const { data, error } = await db.rpc(
    'validate_invite_code_hash',
    { p_code_hash: codeHash || null }
  );

  if (error || !data) {
    throw new Error('invite_validation_failed');
  }

  return {
    valid: data.valid === true,
    required: data.required === true
  };
}

function createHandler(dependencies = {}) {
  const getClient = dependencies.serviceClient || serviceClient;
  const validate = dependencies.validateHash || validateHash;

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Allow', 'POST');

    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        error: 'METHOD_NOT_ALLOWED',
        message: 'この操作は利用できません。'
      });
    }

    const codeHash = normalizeHash(req.body?.codeHash);

    if (codeHash === null) {
      return res.status(200).json({
        ok: true,
        valid: false,
        required: true,
        message: '招待コードを確認してください。'
      });
    }

    const db = getClient();

    if (!db) {
      return res.status(503).json({
        ok: false,
        error: 'INVITE_CONFIGURATION_ERROR',
        message: '招待コードを確認できませんでした。'
      });
    }

    try {
      const result = await validate(db, codeHash);

      return res.status(200).json({
        ok: true,
        valid: result.valid,
        required: result.required,
        message: result.valid
          ? ''
          : result.required && !codeHash
            ? '招待コードを入力してください。'
            : '招待コードが正しくないか、現在利用できません。'
      });
    } catch (_) {
      return res.status(503).json({
        ok: false,
        error: 'INVITE_VALIDATION_UNAVAILABLE',
        message: '招待コードを確認できませんでした。'
      });
    }
  };
}

const handler = createHandler();

module.exports = handler;
module.exports._test = {
  createHandler,
  normalizeHash,
  validateHash
};

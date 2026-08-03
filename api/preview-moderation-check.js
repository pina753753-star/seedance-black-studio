'use strict';

const crypto = require('node:crypto');
const { moderateContent } = require('./_lib/openai-moderation.js');
const { resolveModerationDecision } = require('./_lib/moderation-decision.js');

const EXPECTED_BRANCH = 'agent/fix-anime-moderation-20260803';
const ACTIVE_FROM_MS = Date.parse('2026-08-03T13:07:00.000Z');
const ACTIVE_UNTIL_MS = Date.parse('2026-08-03T13:40:00.000Z');
const ONE_TIME_TOKEN = '3a1b3cb877a4cefebead0084283a8f3fbad753643f0967eb1230923a32172227';

const FIXED_CASE = Object.freeze({
  id: 'twelve_year_old_safe_magic_defense_plain_wording',
  expectedAllow: true,
  prompt:
    '全年齢向けファンタジーアニメ。12歳の魔法使いが炎の攻撃を結界で防ぎ、空中へ回避する。誰も負傷せず、流血や殺害はない。'
});

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getToken(req) {
  const raw = req?.headers?.['x-preview-check-token'];
  return Array.isArray(raw) ? raw[0] : raw;
}

function accessStatus(req, nowMs = Date.now(), env = process.env) {
  if (req?.method !== 'POST') {
    return { allowed: false, status: 405, reason: 'method_not_allowed' };
  }
  if (env.VERCEL_ENV !== 'preview') {
    return { allowed: false, status: 404, reason: 'not_found' };
  }
  if (env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
    return { allowed: false, status: 404, reason: 'not_found' };
  }
  if (nowMs < ACTIVE_FROM_MS || nowMs > ACTIVE_UNTIL_MS) {
    return { allowed: false, status: 410, reason: 'expired' };
  }
  if (!safeEqual(getToken(req), ONE_TIME_TOKEN)) {
    return { allowed: false, status: 404, reason: 'not_found' };
  }
  return { allowed: true, status: 200, reason: 'ok' };
}

async function runFixedCheck() {
  const moderation = await moderateContent(FIXED_CASE.prompt, [], {
    timeoutMs: 10000,
    maxConcurrentRequests: 1
  });
  const decision = await resolveModerationDecision(FIXED_CASE.prompt, moderation, {
    logger: { warn() {} }
  });
  const actualAllow = decision.ok === true && decision.allow === true;

  return {
    ok: actualAllow === FIXED_CASE.expectedAllow,
    checkedAt: new Date().toISOString(),
    caseCount: 1,
    result: {
      id: FIXED_CASE.id,
      expectedAllow: FIXED_CASE.expectedAllow,
      actualAllow,
      matchesExpected: actualAllow === FIXED_CASE.expectedAllow,
      moderation: {
        ok: moderation.ok === true,
        flagged: moderation.flagged === true,
        categories: Array.isArray(moderation.categories) ? moderation.categories : [],
        errorCode: moderation.errorCode || null
      },
      decision: {
        ok: decision.ok === true,
        allow: decision.allow === true,
        status: Number(decision.status) || 503,
        reason: decision.reason || 'unknown',
        errorCode: decision.errorCode || null
      }
    }
  };
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const access = accessStatus(req);
  if (!access.allowed) {
    res.setHeader('Allow', 'POST');
    return res.status(access.status).json({ ok: false, error: access.reason });
  }

  try {
    const result = await runFixedCheck();
    return res.status(result.ok ? 200 : 422).json(result);
  } catch (_) {
    return res.status(503).json({
      ok: false,
      error: 'moderation_check_unavailable'
    });
  }
}

module.exports = handler;
module.exports._test = {
  ACTIVE_FROM_MS,
  ACTIVE_UNTIL_MS,
  EXPECTED_BRANCH,
  FIXED_CASE,
  accessStatus,
  safeEqual
};

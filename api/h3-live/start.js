'use strict';

// POST /api/h3-live/start
//
// Reserve an H3 Live job, charge 110 existing credits, and submit the
// instruction to fal.ai's H3 Max queue. Standalone: shares no code with the
// Seedance generation flow, the billing code, or the watermark server. The
// only shared surface is the credit balance/ledger, touched exclusively
// through the H3-only RPCs in
// supabase/migrations/20260831090000_create_h3_live_slice.sql.
//
// Headers:  Authorization: Bearer <Supabase JWT>   (required)
//           Idempotency-Key: <uuid>                (required)
// Body:     { "instruction": "<1..2000 chars>", "mode": "text"|"image",
//             "uploadId": "<uuid, image mode only>" }
//
// Order: auth -> kill switch -> validate -> plan -> (image: resolve + validate
// + moderate frame) -> text moderation -> provider config -> reserve -> deduct
// -> kill-switch recheck -> (image: sign frame URL) -> fal submit -> persist.
// No fal.ai call happens before a committed deduction; a definite provider
// rejection triggers a confirmed refund before the error is returned.
//
// An idempotent replay of an interrupted first attempt resumes the deduct +
// submit steps ONLY when the job is still uncharged and unsubmitted. A job that
// was charged but has no provider request id / tracking URLs is never resent
// (double-generation risk) or auto-refunded — it is left for the operator
// reconciler, api/h3-live/reconcile.js.

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const {
  jsonBody,
  serviceClient,
  checkH3LiveEnabled,
  isUuid,
  sanitizeJob
} = require('../_lib/h3-live-store.js');
const { getH3LiveEntitlement } = require('../_lib/h3-live-entitlement.js');
const { moderateH3LiveInstruction } = require('../_lib/h3-live-moderation.js');
const { moderateH3LiveImageInput } = require('../_lib/h3-live-image-moderation.js');
const { submitTextJob, submitImageJob } = require('../_lib/h3-live-fal.js');
const {
  getUploadRow,
  downloadAndValidate,
  createModerationSignedUrl,
  createFalSignedUrl,
  markModeration,
  deleteUploadObject,
  sweepStaleUploads
} = require('../_lib/h3-live-image-store.js');
const {
  INSTRUCTION_MIN_CHARS,
  INSTRUCTION_MAX_CHARS,
  CREDIT_COST,
  STATUS_POLL_MS,
  FAL_MODEL_ID_TEXT,
  FAL_MODEL_ID_IMAGE,
  requireProviderConfig,
  requireModerationConfig
} = require('../_lib/h3-live-config.js');

function idempotencyKey(req) {
  const raw = req?.headers?.['idempotency-key'] || req?.headers?.['Idempotency-Key'] || '';
  return String(raw).trim();
}

async function fetchJob(db, jobId) {
  const { data, error } = await db.from('h3_live_jobs').select('*').eq('id', jobId).maybeSingle();
  if (error) console.error('[h3-live/start] fetchJob error:', error.message, 'jobId:', jobId);
  return data || null;
}

// Calls the idempotent refund RPC, retrying a few times because a transport
// error can arrive after the DB transaction actually committed. Returns
// confirmed:true only when the RPC itself reported a terminal outcome.
async function refundJob(db, jobId, errorCode, errorMessage) {
  let lastCode = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data, error } = await db.rpc('refund_h3_live_job_atomic', {
        p_job_id: jobId,
        p_error_code: String(errorCode || 'h3_live_failed').slice(0, 100),
        p_error_message: String(errorMessage || '').slice(0, 1000)
      });
      if (!error) {
        const code = data?.code || null;
        if (['refunded', 'already_refunded', 'no_charge_found', 'already_completed'].includes(code)) {
          return {
            confirmed: true,
            refunded: ['refunded', 'already_refunded'].includes(code),
            code
          };
        }
        lastCode = code;
      } else {
        lastCode = error.message;
      }
    } catch (e) {
      lastCode = e?.message || String(e);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  return { confirmed: false, refunded: false, code: lastCode };
}

const REFUND_UNCONFIRMED_MESSAGE =
  'システムの状態を確認できませんでした。二重請求を避けるため、同じ内容で再生成せず、時間をおいて履歴をご確認いただくか、サポートへご連絡ください。';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({
      ok: true,
      endpoint: '/api/h3-live/start',
      method: 'POST',
      note: 'POST only. Authorization: Bearer <supabase-jwt> and Idempotency-Key: <uuid> required.',
      models: { text: FAL_MODEL_ID_TEXT, image: FAL_MODEL_ID_IMAGE },
      modes: ['text', 'image'],
      fixed: { durationSeconds: 15, resolution: '768p', creditCost: CREDIT_COST }
    });
  }

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const user = auth.user;
  const db = auth.supabase || serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  // Opportunistic cleanup of abandoned image uploads (bounded, never throws).
  sweepStaleUploads(db).catch(() => {});

  // Kill switch — checked before any validation, DB write, or provider call.
  const control = await checkH3LiveEnabled(db);
  if (!control.ok) {
    return res.status(503).json({
      ok: false,
      error: 'h3_live_disabled',
      message: 'H3 Live は現在利用できません。しばらくしてからお試しください。'
    });
  }

  // Idempotency key + instruction validation.
  const idemKey = idempotencyKey(req);
  if (!isUuid(idemKey)) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_idempotency_key',
      message: 'リクエストキーが不正です。ページを再読み込みしてお試しください。'
    });
  }

  const body = jsonBody(req);
  const instruction = String(body.instruction || '').trim();
  if (instruction.length < INSTRUCTION_MIN_CHARS || instruction.length > INSTRUCTION_MAX_CHARS) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_instruction',
      message: `指示は1〜${INSTRUCTION_MAX_CHARS}文字で入力してください。`
    });
  }

  // Input mode. 'image' also needs a valid uploadId naming an
  // h3_live_image_uploads row this user created via /api/h3-live/image-upload-url.
  const mode = body.mode === 'image' ? 'image' : 'text';
  const uploadId = mode === 'image' ? String(body.uploadId || '').trim() : null;
  if (mode === 'image' && !isUuid(uploadId)) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_upload_id',
      message: '添付画像を確認できませんでした。画像を選び直してお試しください。'
    });
  }

  // Plan eligibility (Premium / Scale / Team / Ultimate, unexpired).
  const entitlement = await getH3LiveEntitlement(db, user.id);
  if (!entitlement.ok) {
    return res.status(503).json({
      ok: false,
      error: 'plan_check_unavailable',
      message: '現在プランを確認できないため、H3 Live を開始できません。しばらくしてからお試しください。'
    });
  }
  if (!entitlement.allowed) {
    return res.status(403).json({
      ok: false,
      error: 'h3_live_plan_required',
      message: 'H3 Live は Premium 以上のプラン（有効期間内）でご利用いただけます。',
      redirect: '/pricing.html#monthly'
    });
  }

  // Fail-closed content safety before reservation or charge.
  const modConfig = requireModerationConfig();
  if (!modConfig.ok) {
    return res.status(503).json({
      ok: false,
      error: 'content_safety_check_unavailable',
      message: '現在コンテンツの安全確認を行えないため、開始できません。しばらくしてからお試しください。'
    });
  }

  const CONTENT_SAFETY_UNAVAILABLE = {
    ok: false,
    error: 'content_safety_check_unavailable',
    message: '現在コンテンツの安全確認を行えないため、開始できません。しばらくしてからお試しください。'
  };

  // Image-mode holds onto the resolved upload row so it can be swept on any
  // downstream failure once the job exists.
  let imageUploadRow = null;
  let imageContentType = null;

  if (mode === 'image') {
    const found = await getUploadRow(db, uploadId, user.id);
    if (!found.ok) {
      return res.status(found.error === 'upload_not_found' ? 404 : 500).json({
        ok: false,
        error: found.error,
        message: '添付画像を確認できませんでした。画像を選び直してお試しください。'
      });
    }
    imageUploadRow = found.row;

    // The frame may already be bound to a job. That is only acceptable when it
    // is THIS caller's job for THIS idempotency key and still resumable — i.e.
    // an idempotent replay of the same request. Any other binding means the
    // frame was already consumed by a different job.
    let boundToOwnReplay = false;
    let boundJobCharged = false;
    if (imageUploadRow.job_id) {
      const boundJob = await fetchJob(db, imageUploadRow.job_id);
      boundToOwnReplay = Boolean(
        boundJob &&
        boundJob.user_id === user.id &&
        String(boundJob.idempotency_key || '').toLowerCase() === idemKey.toLowerCase() &&
        ['queued', 'submitting', 'processing'].includes(boundJob.status)
      );
      boundJobCharged = boundToOwnReplay && Boolean(boundJob.charged_at);
    }

    if (
      imageUploadRow.deleted_at ||
      imageUploadRow.moderation_status === 'blocked' ||
      (imageUploadRow.job_id && !boundToOwnReplay)
    ) {
      return res.status(409).json({
        ok: false,
        error: 'image_not_usable',
        message: 'この画像は使用できません。画像を選び直してお試しください。'
      });
    }

    // A charged replay was validated and moderated on its first attempt and its
    // frame cannot have been swapped since (the job is bound). Skip re-download
    // and re-moderation here — re-moderating could 422 an already-charged
    // request. The idempotent-replay handling after reserve takes over.
    if (!boundJobCharged) {
      const validated = await downloadAndValidate(db, imageUploadRow.object_path);
      if (!validated.ok) {
        const map = { image_too_large: 413, unsupported_image_type: 415, quarantine_object_not_found: 404, empty_object: 400 };
        return res.status(map[validated.error] || 400).json({
          ok: false,
          error: validated.error,
          message: '添付画像を読み込めませんでした。別の画像でお試しください。'
        });
      }
      imageContentType = validated.contentType;

      // Always re-moderate the frame + instruction (any flagged category
      // blocks). Running it on every attempt closes the window between a prior
      // "passed" verdict and this reservation; a retry is rare so the extra
      // moderation call is negligible. Nothing has been charged at this point
      // (moderation precedes reserve for a fresh job, and an uncharged replay
      // has charged_at IS NULL), so a block here is safe to 422.
      const signed = await createModerationSignedUrl(db, imageUploadRow.object_path);
      if (!signed.ok) {
        console.error('[h3-live/start] moderation signed URL failed:', signed.error);
        return res.status(503).json(CONTENT_SAFETY_UNAVAILABLE);
      }

      const imageModeration = await moderateH3LiveImageInput({
        instruction,
        imageUrl: signed.signedUrl
      });

      if (!imageModeration.ok) {
        console.error('[h3-live/start] image moderation unavailable:', imageModeration.reason);
        return res.status(503).json(CONTENT_SAFETY_UNAVAILABLE);
      }
      if (!imageModeration.allow) {
        console.warn(
          '[h3-live/start] image input blocked; source:', imageModeration.source,
          'categories:', imageModeration.categories || []
        );
        await markModeration(db, imageUploadRow.id, 'blocked', {
          categories: imageModeration.categories || [],
          byteSize: validated.buffer.length,
          contentType: imageContentType
        });
        await deleteUploadObject(db, imageUploadRow);
        try {
          await db.from('moderation_blocks').insert({
            user_id: user.id,
            mode: 'h3_live_image_input',
            categories: imageModeration.categories || [],
            reason: `h3_live_${imageModeration.source}_flagged`,
            classification: {
              source: imageModeration.source,
              matchedCategories: imageModeration.categories || []
            },
            prompt: imageModeration.source === 'text' ? instruction : ''
          });
        } catch (logError) {
          console.error('[h3-live/start] moderation_blocks insert failed:', logError?.message || logError);
        }
        return res.status(422).json({
          ok: false,
          error: 'content_policy_violation',
          message: imageModeration.source === 'image'
            ? '添付画像が生成AIのコンテンツポリシーに抵触したため開始できませんでした。別の画像でお試しください。'
            : '入力内容が生成AIのコンテンツポリシーに抵触したため開始できませんでした。内容を変更してお試しください。'
        });
      }

      await markModeration(db, imageUploadRow.id, 'passed', {
        categories: [],
        byteSize: validated.buffer.length,
        contentType: imageContentType
      });
    }
  } else {
    // Text mode: instruction-only moderation (any flagged category blocks).
    const moderation = await moderateH3LiveInstruction(instruction);
    if (!moderation.ok) {
      console.error('[h3-live/start] moderation unavailable:', moderation.reason);
      return res.status(503).json(CONTENT_SAFETY_UNAVAILABLE);
    }
    if (!moderation.allow) {
      console.warn('[h3-live/start] instruction blocked; categories:', moderation.categories || []);
      return res.status(422).json({
        ok: false,
        error: 'content_policy_violation',
        message: '入力内容が生成AIのコンテンツポリシーに抵触したため開始できませんでした。内容を変更してお試しください。'
      });
    }
  }

  // Provider credentials must exist before we charge anyone.
  const providerConfig = requireProviderConfig(mode);
  if (!providerConfig.ok) {
    console.error('[h3-live/start] provider config missing:', providerConfig.missing);
    return res.status(503).json({
      ok: false,
      error: 'provider_unconfigured',
      message: 'H3 Live は現在利用できません。しばらくしてからお試しください。'
    });
  }

  // ---- Reserve ----
  let reservation;
  try {
    const { data, error } = await db.rpc('reserve_h3_live_job_atomic', {
      p_user_id: user.id,
      p_idempotency_key: idemKey,
      p_instruction: instruction,
      p_input_mode: mode,
      p_image_upload_id: mode === 'image' ? uploadId : null
    });
    if (error) {
      console.error('[h3-live/start] reserve RPC error:', error.message);
      return res.status(500).json({ ok: false, error: 'reservation_failed', message: '開始に失敗しました。もう一度お試しください。' });
    }
    reservation = Array.isArray(data) ? data[0] : data;
  } catch (e) {
    console.error('[h3-live/start] reserve exception:', e?.message);
    return res.status(500).json({ ok: false, error: 'reservation_failed', message: '開始に失敗しました。もう一度お試しください。' });
  }

  if (!reservation) {
    return res.status(500).json({ ok: false, error: 'reservation_failed', message: '開始に失敗しました。もう一度お試しください。' });
  }

  const reservationCode = reservation.code || null;

  if (reservationCode === 'idempotency_conflict') {
    return res.status(409).json({
      ok: false,
      error: 'idempotency_conflict',
      message: '別の内容で同じリクエストキーが使われています。ページを再読み込みしてお試しください。'
    });
  }
  if (reservationCode === 'active_job') {
    return res.status(409).json({
      ok: false,
      error: 'h3_live_job_in_progress',
      message: '生成中の動画があります。完了後にもう一度お試しください。'
    });
  }
  if (reservationCode === 'cooldown_active') {
    const secs = Number(reservation.retry_after_seconds) || 10;
    res.setHeader('Retry-After', String(secs));
    return res.status(429).json({
      ok: false,
      error: 'h3_live_cooldown_active',
      message: `前回の生成終了から${secs}秒お待ちください。`,
      retryAfterSeconds: secs
    });
  }
  if (reservationCode === 'service_disabled') {
    return res.status(503).json({
      ok: false,
      error: 'h3_live_disabled',
      message: 'H3 Live は現在利用できません。しばらくしてからお試しください。'
    });
  }
  if (reservationCode === 'image_not_usable') {
    // The frame was consumed, deleted, or bound to another job between
    // moderation and reserve.
    if (imageUploadRow) await deleteUploadObject(db, imageUploadRow).catch(() => {});
    return res.status(409).json({
      ok: false,
      error: 'image_not_usable',
      message: 'この画像は使用できません。画像を選び直してお試しください。'
    });
  }

  const jobId = reservation.job_id;
  if (!jobId) {
    return res.status(500).json({ ok: false, error: 'reservation_failed', message: '開始に失敗しました。もう一度お試しください。' });
  }

  // Idempotent replay: a job already exists for this (user, key).
  if (reservationCode === 'existing') {
    const existingJob = await fetchJob(db, jobId);
    if (!existingJob) {
      // The reserve RPC just matched this row, so a null here is a transient
      // read failure — not a missing job. Do NOT treat it as terminal (that
      // would stop the client polling a real job).
      console.error('[h3-live/start] existing job re-fetch returned nothing. jobId:', jobId);
      return res.status(503).json({
        ok: false,
        error: 'job_lookup_failed',
        message: '生成状況を確認できませんでした。少し待ってから生成状況の画面をご確認ください。',
        jobId
      });
    }
    const jobStatus = existingJob ? existingJob.status : null;
    const isActive = ['queued', 'submitting', 'processing'].includes(jobStatus);
    const hasTracking = Boolean(existingJob && existingJob.provider_poll_url && existingJob.provider_response_url);
    const hasRequestId = Boolean(existingJob && existingJob.provider_request_id);
    const isCharged = Boolean(existingJob && existingJob.charged_at);

    if (!isActive || hasTracking || hasRequestId) {
      // Terminal, or the first attempt already reached fal.ai — return as-is and
      // let the status poller own the rest of the lifecycle.
      return res.status(200).json({
        ok: true,
        existing: true,
        job: sanitizeJob(existingJob),
        nextPollAfterMs: isActive ? STATUS_POLL_MS : 0
      });
    }

    if (isCharged) {
      // Charged, but no provider request id and no tracking URLs: we cannot
      // tell whether the interrupted first attempt reached fal.ai. Never resend
      // (double-generation) and never auto-refund. Leave it for the operator
      // reconciler (api/h3-live/reconcile.js).
      console.error('[h3-live/start] interrupted job is charged but unsubmittable — needs reconcile. jobId:', jobId);
      return res.status(202).json({
        ok: true,
        existing: true,
        job: sanitizeJob(existingJob),
        submissionStateUnknown: true,
        message: '送信結果を確認中です。生成状況の画面でしばらくお待ちください。',
        nextPollAfterMs: STATUS_POLL_MS
      });
    }

    // Uncharged and unsubmitted: the first attempt was interrupted before any
    // charge. Safe to resume — fall through to the deduct + submit path below
    // (every step is keyed on jobId and the deduct RPC is idempotent).
    console.warn('[h3-live/start] resuming interrupted, uncharged job. jobId:', jobId);
  }

  // ---- Deduct 110 credits ----
  let deduction;
  try {
    const { data, error } = await db.rpc('deduct_h3_live_credits_atomic', {
      p_job_id: jobId,
      p_user_id: user.id
    });
    if (error) {
      console.error('[h3-live/start] deduct RPC error:', error.message, 'jobId:', jobId);
      const r = await refundJob(db, jobId, 'deduct_error', error.message);
      return res.status(r.confirmed ? 500 : 503).json(r.confirmed
        ? { ok: false, error: 'charge_failed', message: '開始に失敗しました。クレジットは消費されていません。' }
        : { ok: false, error: 'refund_state_uncertain', message: REFUND_UNCONFIRMED_MESSAGE, jobId });
    }
    deduction = data;
  } catch (e) {
    console.error('[h3-live/start] deduct exception:', e?.message, 'jobId:', jobId);
    const r = await refundJob(db, jobId, 'deduct_exception', e?.message);
    return res.status(r.confirmed ? 500 : 503).json(r.confirmed
      ? { ok: false, error: 'charge_failed', message: '開始に失敗しました。クレジットは消費されていません。' }
      : { ok: false, error: 'refund_state_uncertain', message: REFUND_UNCONFIRMED_MESSAGE, jobId });
  }

  if (!deduction?.ok) {
    // reserve/deduct RPCs already move the job to a terminal failed state for
    // insufficient_credits / service_disabled / balance_not_found.
    if (deduction?.code === 'insufficient_credits') {
      return res.status(402).json({
        ok: false,
        error: 'insufficient_credits',
        message: `クレジットが不足しています（残高: ${deduction.balance}、必要: ${deduction.required}）。`,
        balance: deduction.balance,
        required: deduction.required
      });
    }
    if (deduction?.code === 'service_disabled') {
      return res.status(503).json({ ok: false, error: 'h3_live_disabled', message: 'H3 Live は現在利用できません。' });
    }
    if (deduction?.code === 'balance_not_found') {
      return res.status(402).json({ ok: false, error: 'balance_not_found', message: 'クレジット残高を確認できませんでした。' });
    }
    // job_not_chargeable / job_owner_mismatch / unknown — release via refund RPC.
    // Match every other post-charge path: only frame this as a clean failure
    // once the refund is confirmed. An unexpected / future RPC code could stand
    // for a charged state, and the retry would land on the 'existing' replay
    // branch without recovering.
    const rejectRefund = await refundJob(db, jobId, deduction?.code || 'not_chargeable', 'deduction rejected');
    if (!rejectRefund.confirmed) {
      console.error('[h3-live/start] deduct-reject refund unconfirmed. jobId:', jobId, 'code:', rejectRefund.code);
      return res.status(503).json({
        ok: false,
        error: 'refund_state_uncertain',
        message: REFUND_UNCONFIRMED_MESSAGE,
        jobId
      });
    }
    return res.status(409).json({ ok: false, error: deduction?.code || 'charge_failed', message: '開始に失敗しました。もう一度お試しください。' });
  }

  const creditBalance = Number(deduction.new_balance);
  const providerModelId = mode === 'image' ? FAL_MODEL_ID_IMAGE : FAL_MODEL_ID_TEXT;

  // Move queued -> submitting and record the provider model id.
  await db.from('h3_live_jobs')
    .update({ status: 'submitting', provider_model_id: providerModelId, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'queued');

  // Kill switch may have been flipped off during moderation/charge. Refund and
  // stop before spending a fal.ai call.
  const controlRecheck = await checkH3LiveEnabled(db);
  if (!controlRecheck.ok) {
    const r = await refundJob(db, jobId, 'disabled_after_charge', 'H3 Live disabled before submission');
    if (mode === 'image' && imageUploadRow) await deleteUploadObject(db, imageUploadRow).catch(() => {});
    if (!r.confirmed) {
      // Do NOT tell the user "disabled" (a clean outcome) while the charge is
      // still outstanding and unrefunded.
      console.error('[h3-live/start] disabled-recheck refund unconfirmed. jobId:', jobId, 'code:', r.code);
      return res.status(503).json({
        ok: false,
        error: 'refund_state_uncertain',
        message: REFUND_UNCONFIRMED_MESSAGE,
        jobId,
        refunded: false,
        creditRefunded: 0
      });
    }
    return res.status(503).json({
      ok: false,
      error: 'h3_live_disabled',
      message: 'H3 Live は現在利用できません。' + (r.refunded ? 'クレジットは返還しました。' : ''),
      refunded: r.refunded,
      creditRefunded: r.refunded ? CREDIT_COST : 0
    });
  }

  // ---- Submit to fal.ai ----
  let submission;
  if (mode === 'image') {
    // Hand fal.ai a short-lived signed URL for the quarantined frame. The
    // charge is already committed, so a signing failure here is a post-charge
    // error: refund, then report.
    const falSigned = await createFalSignedUrl(db, imageUploadRow.object_path);
    if (!falSigned.ok) {
      console.error('[h3-live/start] fal signed URL failed:', falSigned.error, 'jobId:', jobId);
      const r = await refundJob(db, jobId, 'image_url_sign_failed', falSigned.error);
      if (imageUploadRow) await deleteUploadObject(db, imageUploadRow).catch(() => {});
      return res.status(r.confirmed ? 502 : 503).json(r.confirmed
        ? {
            ok: false,
            error: 'image_url_sign_failed',
            message: '生成の開始に失敗しました。' + (r.refunded ? 'クレジットは返還しました。' : ''),
            refunded: r.refunded,
            creditRefunded: r.refunded ? CREDIT_COST : 0
          }
        : { ok: false, error: 'refund_state_uncertain', message: REFUND_UNCONFIRMED_MESSAGE, jobId });
    }
    submission = await submitImageJob({ instruction, imageUrl: falSigned.signedUrl });
  } else {
    submission = await submitTextJob({ instruction });
  }

  if (!submission.ok) {
    // Ambiguous: the request may have reached fal.ai and may keep running. Do
    // NOT refund or resubmit automatically — leave the job in 'submitting'.
    // 'accepted_untrackable' is a 2xx we could not extract tracking URLs from;
    // 'timeout'/'network_error' is a send that may or may not have landed.
    if (['timeout', 'network_error', 'accepted_untrackable'].includes(submission.category)) {
      console.error('[h3-live/start] submission ambiguous:', submission.category, 'jobId:', jobId);
      if (submission.requestId) {
        await db.from('h3_live_jobs')
          .update({ provider_request_id: submission.requestId, updated_at: new Date().toISOString() })
          .eq('id', jobId)
          .in('status', ['submitting', 'queued', 'processing']);
      }
      return res.status(202).json({
        ok: true,
        job: sanitizeJob(await fetchJob(db, jobId)),
        creditBalance,
        submissionStateUnknown: true,
        message: '送信結果を確認中です。生成状況の画面でしばらくお待ちください。',
        nextPollAfterMs: STATUS_POLL_MS
      });
    }

    // Definite rejection — refund, then report. Only frame it as a definite
    // failure once the refund is confirmed.
    const r = await refundJob(db, jobId, `fal_${submission.category}`, submission.detail);
    if (mode === 'image' && imageUploadRow) await deleteUploadObject(db, imageUploadRow).catch(() => {});
    if (!r.confirmed) {
      console.error('[h3-live/start] provider-rejection refund unconfirmed. jobId:', jobId, 'category:', submission.category, 'code:', r.code);
      return res.status(503).json({
        ok: false,
        error: 'refund_state_uncertain',
        message: REFUND_UNCONFIRMED_MESSAGE,
        jobId,
        refunded: false,
        creditRefunded: 0
      });
    }
    const httpStatus = submission.category === 'content_policy' || submission.category === 'invalid_input' ? 422 : 502;
    const message = submission.category === 'content_policy'
      ? '入力内容が生成AIのコンテンツポリシーに抵触したため生成できませんでした。'
      : submission.category === 'invalid_input'
        ? '入力内容に問題があり生成できませんでした。内容をご確認ください。'
        : submission.category === 'rate_limit'
          ? 'リクエストが集中しています。しばらくしてからお試しください。'
          : '生成の開始に失敗しました。しばらくしてからお試しください。';
    return res.status(httpStatus).json({
      ok: false,
      error: `provider_${submission.category}`,
      message: message + (r.refunded ? 'クレジットは返還しました。' : ''),
      refunded: r.refunded,
      creditRefunded: r.refunded ? CREDIT_COST : 0
    });
  }

  // ---- Persist tracking info (retry up to 3 attempts) ----
  let persisted = false;
  for (let attempt = 1; attempt <= 3 && !persisted; attempt++) {
    const { data: rows, error } = await db.from('h3_live_jobs')
      .update({
        status: 'processing',
        provider_request_id: submission.requestId,
        provider_poll_url: submission.statusUrl,
        provider_response_url: submission.responseUrl,
        provider_status: 'IN_QUEUE',
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId)
      .in('status', ['submitting', 'queued', 'processing'])
      .select('id');
    if (!error && Array.isArray(rows) && rows.length === 1) {
      persisted = true;
      break;
    }
    console.error('[h3-live/start] tracking persist attempt', attempt, 'failed', 'jobId:', jobId, 'error:', error?.message || null);
  }

  if (!persisted) {
    // The provider accepted the job but we could not store the request id.
    // Do NOT refund here — a later status check keyed on provider_request_id
    // cannot run, so surface it for support rather than risk a double charge.
    console.error('[h3-live/start] ORPHAN job — provider accepted, tracking not persisted. jobId:', jobId, 'requestId:', submission.requestId);
    return res.status(503).json({
      ok: false,
      error: 'tracking_persist_failed',
      message: '生成は開始されましたが、状態の保存に失敗しました。再生成せず、サポートへお問い合わせください。',
      jobId
    });
  }

  return res.status(202).json({
    ok: true,
    job: sanitizeJob(await fetchJob(db, jobId)),
    creditBalance,
    existing: false,
    nextPollAfterMs: STATUS_POLL_MS
  });
};

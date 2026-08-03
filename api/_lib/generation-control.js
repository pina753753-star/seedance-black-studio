'use strict';

const CONTROL_KEY = 'video_generation';
const STOP_MESSAGE = '現在、動画生成機能を一時停止しています。クレジットは消費されません。再開までしばらくお待ちください。';
const REFUND_UNCONFIRMED_MESSAGE = '生成は開始されませんでしたが、クレジット返還を確認できません。再操作せず、サポートへお問い合わせください。';

function stoppedResult(error) {
  return {
    ok: false,
    status: 503,
    body: {
      ok: false,
      error,
      errorCategory: 'service_unavailable',
      message: STOP_MESSAGE
    }
  };
}

async function checkGenerationControl(db) {
  if (!db || typeof db.from !== 'function') {
    console.error('[generation-control] Supabase client is unavailable');
    return stoppedResult('generation_control_unavailable');
  }

  try {
    const { data, error } = await db
      .from('service_controls')
      .select('enabled')
      .eq('control_key', CONTROL_KEY)
      .maybeSingle();

    if (error) {
      console.error('[generation-control] Control lookup failed:', error.message);
      return stoppedResult('generation_control_unavailable');
    }

    if (!data || data.enabled !== true) {
      if (!data) console.error('[generation-control] Control row is missing:', CONTROL_KEY);
      return stoppedResult('video_generation_temporarily_disabled');
    }

    return { ok: true };
  } catch (error) {
    console.error('[generation-control] Control lookup exception:', error?.message || String(error));
    return stoppedResult('generation_control_unavailable');
  }
}

module.exports = {
  CONTROL_KEY,
  STOP_MESSAGE,
  REFUND_UNCONFIRMED_MESSAGE,
  checkGenerationControl
};

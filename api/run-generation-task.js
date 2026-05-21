function config() {
  return {
    supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    serviceRoleKey: process.env['SUPABASE_' + 'SERVICE_ROLE_KEY'] || '',
    googleApiKey: process.env.GOOGLE_API_KEY || ''
  };
}

const GOOGLE_VEO_CREDIT_COST = 80;

async function supabase(path, options = {}) {
  const { supabaseUrl, serviceRoleKey } = config();
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Missing Supabase environment variables');
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!response.ok) {
    const error = new Error(typeof data === 'string' ? data : JSON.stringify(data));
    error.status = response.status;
    throw error;
  }
  return data;
}

function modelFromTask(task) {
  const raw = String(task.model || task.veo_model || task.resolution || '').trim();
  if (raw && raw.startsWith('models/veo-')) return raw;
  return 'models/veo-3.0-fast-generate-001';
}

function aspectFromTask(task) {
  const aspect = String(task.aspect_ratio || '9:16').trim();
  if (['16:9', '9:16'].includes(aspect)) return aspect;
  return '9:16';
}

function totalCredits(balance) {
  return Number(balance?.free_credits || 0) + Number(balance?.subscription_credits || 0) + Number(balance?.purchased_credits || 0);
}

function debitCredits(balance, cost) {
  let remaining = Number(cost || 0);
  const next = {
    free_credits: Number(balance?.free_credits || 0),
    subscription_credits: Number(balance?.subscription_credits || 0),
    purchased_credits: Number(balance?.purchased_credits || 0)
  };

  const useFree = Math.min(next.free_credits, remaining);
  next.free_credits -= useFree;
  remaining -= useFree;

  const useSub = Math.min(next.subscription_credits, remaining);
  next.subscription_credits -= useSub;
  remaining -= useSub;

  const usePurchased = Math.min(next.purchased_credits, remaining);
  next.purchased_credits -= usePurchased;
  remaining -= usePurchased;

  if (remaining > 0) return null;
  return next;
}

function refundCredits(balance, cost) {
  return {
    free_credits: Number(balance?.free_credits || 0) + Number(cost || 0),
    subscription_credits: Number(balance?.subscription_credits || 0),
    purchased_credits: Number(balance?.purchased_credits || 0)
  };
}

async function chargeUserCredits(userId, cost) {
  if (!userId) throw new Error('Task has no user_id');
  const rows = await supabase(`credit_balances?select=*&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
  const balance = rows?.[0];
  if (!balance) throw new Error('Credit balance not found');
  if (totalCredits(balance) < cost) {
    const error = new Error(`Insufficient credits: ${cost} required`);
    error.status = 402;
    throw error;
  }
  const next = debitCredits(balance, cost);
  if (!next) {
    const error = new Error(`Insufficient credits: ${cost} required`);
    error.status = 402;
    throw error;
  }
  await supabase(`credit_balances?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(next)
  });
  return { before: balance, after: next };
}

async function refundUserCredits(userId, charged) {
  if (!userId || !charged?.after) return;
  const refunded = refundCredits(charged.after, GOOGLE_VEO_CREDIT_COST);
  try {
    await supabase(`credit_balances?user_id=eq.${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(refunded)
    });
  } catch (_) {}
}

async function callVeo({ model, prompt, aspectRatio }) {
  const { googleApiKey } = config();
  if (!googleApiKey) throw new Error('Missing GOOGLE_API_KEY');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:predictLongRunning?key=${encodeURIComponent(googleApiKey)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { aspectRatio }
    })
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }

  if (!response.ok) {
    const error = new Error(typeof data === 'string' ? data : JSON.stringify(data));
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return { data, operationName: data?.name || null, status: response.status };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({
      ok: true,
      endpoint: '/api/run-generation-task',
      method: 'POST',
      exampleBody: { taskId: 'generation_tasks id' },
      creditCost: GOOGLE_VEO_CREDIT_COST,
      note: 'Runs a saved draft task with Veo. This can incur Google API cost.'
    });
  }

  let charged = null;
  let userId = null;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const taskId = String(body.taskId || body.id || '').trim();
    if (!taskId) return res.status(400).json({ ok: false, error: 'taskId is required' });

    const tasks = await supabase(`generation_tasks?select=*&id=eq.${encodeURIComponent(taskId)}&limit=1`);
    const task = tasks?.[0];
    if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
    if (!task.prompt) return res.status(400).json({ ok: false, error: 'Task has no prompt' });
    if (!['draft', 'queued', 'pending', 'failed', 'error'].includes(String(task.status || 'draft'))) {
      return res.status(400).json({ ok: false, error: `Task status is not runnable: ${task.status}` });
    }

    const model = modelFromTask(task);
    const aspectRatio = aspectFromTask(task);
    userId = task.user_id || null;

    charged = await chargeUserCredits(userId, GOOGLE_VEO_CREDIT_COST);

    let userEmail = null;
    if (userId) {
      try {
        const profiles = await supabase(`profiles?select=email&id=eq.${encodeURIComponent(userId)}&limit=1`);
        userEmail = profiles?.[0]?.email || null;
      } catch (_) {}
    }

    await supabase(`generation_tasks?id=eq.${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'processing', credit_cost: GOOGLE_VEO_CREDIT_COST })
    });

    let veo;
    try {
      veo = await callVeo({ model, prompt: task.prompt, aspectRatio });
    } catch (error) {
      await refundUserCredits(userId, charged);
      await supabase(`generation_tasks?id=eq.${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'failed' })
      });
      throw error;
    }

    const operationName = veo.operationName;
    if (!operationName) {
      await refundUserCredits(userId, charged);
      await supabase(`generation_tasks?id=eq.${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'failed' })
      });
      return res.status(500).json({ ok: false, error: 'Veo did not return operationName', response: veo.data });
    }

    await supabase('generated_videos', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_email: userEmail,
        provider: 'veo',
        model,
        operation_name: operationName,
        prompt: task.prompt,
        aspect_ratio: aspectRatio,
        duration_seconds: Number(task.duration_seconds || 5),
        video_uri: null,
        credit_cost: GOOGLE_VEO_CREDIT_COST,
        status: 'processing'
      })
    });

    return res.status(200).json({
      ok: true,
      taskId,
      status: 200,
      provider: 'veo',
      model,
      aspectRatio,
      operationName,
      creditCost: GOOGLE_VEO_CREDIT_COST,
      note: 'Veo generation started. Use Generate Result Check or history after completion.',
      response: veo.data,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      ok: false,
      error: error?.message || 'Unknown error',
      details: error?.data || null,
      checkedAt: new Date().toISOString()
    });
  }
}

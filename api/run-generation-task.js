function config() {
  return {
    supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    serviceRoleKey: process.env['SUPABASE_' + 'SERVICE_ROLE_KEY'] || '',
    googleApiKey: process.env.GOOGLE_API_KEY || ''
  };
}

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
      note: 'Runs a saved draft task with Veo. This can incur Google API cost.'
    });
  }

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
    const userId = task.user_id || null;

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
      body: JSON.stringify({ status: 'processing' })
    });

    let veo;
    try {
      veo = await callVeo({ model, prompt: task.prompt, aspectRatio });
    } catch (error) {
      await supabase(`generation_tasks?id=eq.${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'failed' })
      });
      throw error;
    }

    const operationName = veo.operationName;
    if (!operationName) {
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
        credit_cost: Number(task.credit_cost || 128),
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

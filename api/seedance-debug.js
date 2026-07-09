// Read-only debug endpoint for inspecting an existing OpenRouter Seedance job.
// GET only. Does not write to Supabase DB/Storage, does not touch credits,
// does not call OpenRouter's generation-create endpoint (only the status/polling GET).
//
// URL classification mirrors api/seedance-status.js so debug output reflects
// production behavior:
//   isStatusEndpointUrl / isOpenRouterContentUrl / normalizeStatus /
//   isCompletedStatus / isFailedStatus / effectiveJobId / openRouterContentUrl

const OPENROUTER_VIDEO_ENDPOINT = 'https://openrouter.ai/api/v1/videos';

function isStatusEndpointUrl(url) {
  const value = String(url || '');
  return /^https?:\/\/openrouter\.ai\/api\/v1\/videos\/[^/?#]+\/?(?:[?#].*)?$/i.test(value);
}

function isOpenRouterContentUrl(url) {
  return /^https?:\/\/openrouter\.ai\/api\/v1\/videos\/[^/?#]+\/content(?:\?|$)/i.test(String(url || ''));
}

function normalizeStatus(data) {
  return String(data?.status || data?.data?.status || data?.response?.status || data?.result?.status || '').toLowerCase();
}

function isCompletedStatus(status) {
  return ['completed', 'complete', 'succeeded', 'success', 'done'].includes(String(status || '').toLowerCase());
}

function isFailedStatus(status) {
  return ['failed', 'error', 'cancelled', 'canceled'].includes(String(status || '').toLowerCase());
}

function isPendingStatus(status) {
  return ['pending', 'queued', 'processing', 'running', 'in_progress'].includes(String(status || '').toLowerCase());
}

function effectiveJobId({ jobId, pollingUrl }) {
  if (jobId) return jobId;
  try {
    if (!pollingUrl || !/^https?:\/\//i.test(pollingUrl)) return null;
    const parsed = new URL(pollingUrl);
    const queryId = parsed.searchParams.get('id') || parsed.searchParams.get('jobId') || parsed.searchParams.get('job_id');
    if (queryId) return String(queryId).trim();
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const pathId = pathParts[pathParts.length - 1];
    if (pathId && !/^(download|output|video|file|public|content)$/i.test(pathId)) return pathId;
  } catch (_) {
    // Ignore malformed URL and fall through.
  }
  return null;
}

function openRouterContentUrl(id) {
  const clean = String(id || '').trim();
  if (!clean) return null;
  return `${OPENROUTER_VIDEO_ENDPOINT}/${encodeURIComponent(clean)}/content`;
}

// Collect every string URL found anywhere in the response, with its object path.
function findUrls(value, path = '', out = []) {
  if (!value) return out;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) out.push({ path, url: value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findUrls(item, `${path}[${index}]`, out));
    return out;
  }
  if (typeof value === 'object') {
    Object.keys(value).forEach((key) => findUrls(value[key], path ? `${path}.${key}` : key, out));
  }
  return out;
}

// Classify each discovered URL using the same rules api/seedance-status.js applies,
// and record why a URL was accepted or rejected as a video candidate.
function classifyUrls(data) {
  const candidateUrls = [];
  const rejectedUrls = [];

  for (const item of findUrls(data)) {
    const { path, url } = item;

    if (isOpenRouterContentUrl(url)) {
      candidateUrls.push({ path, url, reason: 'openrouter_content_url' });
      continue;
    }
    if (/\.(mp4|mov|webm)(\?|$)/i.test(url)) {
      candidateUrls.push({ path, url, reason: 'video_file_extension' });
      continue;
    }
    if (isStatusEndpointUrl(url)) {
      rejectedUrls.push({ path, url, reason: 'status_url_not_video' });
      continue;
    }

    const keyLooksLikeVideo = /(videoUrl|video_url|output_url|download_url|file_url|asset_url|signed_url|signed_urls|unsigned_url|unsigned_urls|play_url|url)$/i.test(
      path.split(/[.[]/).pop() || ''
    );
    const urlLooksDownloadable = /(download|output|storage|cdn|signed|play|file|asset|content\?index=)/i.test(url);

    if (keyLooksLikeVideo && urlLooksDownloadable) {
      candidateUrls.push({ path, url, reason: 'key_and_pattern_match' });
    } else {
      rejectedUrls.push({ path, url, reason: 'no_video_signal' });
    }
  }

  return { candidateUrls, rejectedUrls };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }

  const jobId = String(req.query.id || req.query.jobId || '').trim();
  const pollingUrl = String(req.query.pollingUrl || req.query.polling_url || '').trim();

  if (!jobId && !pollingUrl) {
    return res.status(400).json({ ok: false, error: 'pollingUrl (or id) query parameter is required' });
  }

  if (pollingUrl && !/^https:\/\/openrouter\.ai\/api\/v1\/videos\//i.test(pollingUrl)) {
    return res.status(400).json({ ok: false, error: 'pollingUrl must be an https://openrouter.ai/api/v1/videos/... URL' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!apiKey) return res.status(500).json({ ok: false, error: 'Missing OPENROUTER_API_KEY' });

  const statusUrl = pollingUrl || `${OPENROUTER_VIDEO_ENDPOINT}/${encodeURIComponent(jobId)}`;

  try {
    const response = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://flowvid-studio.vercel.app',
        'X-Title': 'FlowVid Studio'
      }
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }

    const jobStatus = normalizeStatus(data);
    const completed = isCompletedStatus(jobStatus);
    const failed = isFailedStatus(jobStatus);
    const pending = !completed && !failed && (isPendingStatus(jobStatus) || (!jobStatus && response.ok));

    const { candidateUrls, rejectedUrls } = classifyUrls(data);
    const resolvedJobId = effectiveJobId({ jobId, pollingUrl });

    // Prefer a real candidate URL found in the response. Only fall back to the
    // OpenRouter content-URL guess when the job is completed and nothing else was found.
    let selectedVideoUrl = candidateUrls.length ? candidateUrls[0].url : null;
    let usedFallbackContentUrl = false;
    if (!selectedVideoUrl && completed && resolvedJobId) {
      selectedVideoUrl = openRouterContentUrl(resolvedJobId);
      usedFallbackContentUrl = Boolean(selectedVideoUrl);
    }

    return res.status(200).json({
      ok: true,
      debugOnly: true,
      pollingUrl: pollingUrl || null,
      jobId: jobId || null,
      resolvedJobId,
      openrouterStatus: response.status,
      raw: data,
      normalized: {
        status: jobStatus || null,
        done: completed && Boolean(selectedVideoUrl),
        completed,
        failed,
        pending,
        candidateUrls,
        selectedVideoUrl,
        usedFallbackContentUrl,
        rejectedUrls
      },
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error), statusUrl, checkedAt: new Date().toISOString() });
  }
};

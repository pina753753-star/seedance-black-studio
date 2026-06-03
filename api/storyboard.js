const SYSTEM_PROMPT = `あなたは絵コンテ解析の専門家です。
アップロードされた絵コンテ画像を解析し、各カットの情報をJSON形式で返してください。

返すJSONの形式：
{
  "cuts": [
    {
      "cut_number": 1,
      "duration": 5,
      "prompt": "Seedance 2.0向けの英語プロンプト",
      "camera": "カメラワークの説明",
      "content": "カットの内容説明"
    }
  ],
  "total_cuts": 9,
  "style": "映像スタイルの説明"
}

promptフィールドは必ずSeedance 2.0で高品質な動画が生成できる英語プロンプトにしてください。
JSONのみ返してください。前後の説明文は不要です。`;

function jsonBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
  }
  return req.body || {};
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY is not configured.' });
  }

  const body = jsonBody(req);
  const { image, mediaType = 'image/jpeg' } = body;

  if (!image) {
    return res.status(400).json({ ok: false, error: 'image (base64) is required.' });
  }

  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowed.includes(mediaType)) {
    return res.status(400).json({ ok: false, error: `mediaType must be one of: ${allowed.join(', ')}` });
  }

  const base64 = String(image).replace(/^data:[^;]+;base64,/, '');

  let response, data;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: SYSTEM_PROMPT }
          ]
        }]
      })
    });
    data = await response.json().catch(() => ({}));
  } catch (err) {
    return res.status(502).json({ ok: false, error: `Anthropic API network error: ${err?.message || String(err)}` });
  }

  if (!response.ok) {
    return res.status(502).json({ ok: false, error: `Anthropic API error ${response.status}`, detail: data });
  }

  const text = String(data?.content?.[0]?.text ?? '');
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = jsonMatch ? jsonMatch[1].trim() : text.trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (_) {
    return res.status(502).json({ ok: false, error: 'Failed to parse JSON from Claude response.', raw: text.slice(0, 500) });
  }

  return res.status(200).json({ ok: true, result: parsed });
};

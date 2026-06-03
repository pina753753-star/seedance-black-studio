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

  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'OPENROUTER_API_KEY is not configured.' });
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

  let response, data;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 2000,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image } },
            { type: 'text', text: '上記の絵コンテ画像を解析してください。' }
          ]}
        ]
      })
    });
    const rawText = await response.text();
    try { data = JSON.parse(rawText); } catch(_) { data = { error: rawText.slice(0, 300) }; }
  } catch (err) {
    return res.status(502).json({ ok: false, error: `network error: ${err?.message || String(err)}` });
  }

  if (!response.ok) {
    return res.status(502).json({ ok: false, error: `OpenRouter error ${response.status}: ${JSON.stringify(data).slice(0,300)}` });
  }

  const text = String(data?.choices?.[0]?.message?.content ?? '');

  let parsed;
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonText = jsonMatch ? jsonMatch[1].trim() : text.trim();
    parsed = JSON.parse(jsonText);
  } catch (_) {
    try {
      const objMatch = text.match(/\{[\s\S]*\}/);
      if (!objMatch) throw new Error('no JSON found');
      parsed = JSON.parse(objMatch[0]);
    } catch (_2) {
      return res.status(502).json({ ok: false, error: 'JSONパース失敗', raw: text.slice(0, 500) });
    }
  }

  return res.status(200).json({ ok: true, result: parsed });
};

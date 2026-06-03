import { NextResponse } from "next/server";

export const runtime = "nodejs";

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

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not configured." }, { status: 500 });
  }

  let body: { image: string; mediaType?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { image, mediaType = "image/jpeg" } = body;
  if (!image) {
    return NextResponse.json({ error: "image (base64) is required." }, { status: 400 });
  }

  const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  if (!allowedTypes.includes(mediaType)) {
    return NextResponse.json({ error: `mediaType must be one of: ${allowedTypes.join(", ")}` }, { status: 400 });
  }

  // Strip data URL prefix if present (e.g. "data:image/jpeg;base64,...")
  const base64 = image.replace(/^data:[^;]+;base64,/, "");

  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: base64
                }
              },
              {
                type: "text",
                text: "この絵コンテを解析してください。"
              }
            ]
          }
        ]
      })
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Anthropic API network error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    return NextResponse.json(
      { error: `Anthropic API error ${response.status}`, detail: errorBody },
      { status: 502 }
    );
  }

  const data = await response.json();
  const text: string = data?.content?.[0]?.text ?? "";

  // Extract JSON — model may occasionally wrap it in a code fence
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? null;
  const jsonText = jsonMatch ? jsonMatch[1].trim() : text.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return NextResponse.json(
      { error: "Failed to parse JSON from Claude response.", raw: text },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, result: parsed });
}

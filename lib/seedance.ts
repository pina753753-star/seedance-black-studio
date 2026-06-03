import type { CreateTaskInput } from "./types";
import { normalizeProviderStatus } from "./store";

const provider = process.env.SEEDANCE_PROVIDER ?? "mock";
const apiKey = process.env.SEEDANCE_API_KEY ?? process.env.OPENROUTER_API_KEY;

export function buildSeedancePayload(input: CreateTaskInput) {
  const imageUrls = input.assets.filter((a) => a.type === "image" && a.url).map((a) => a.url);
  const videoUrls = input.assets.filter((a) => a.type === "video" && a.url).map((a) => a.url);
  const audioUrls = input.assets.filter((a) => a.type === "audio" && a.url).map((a) => a.url);

  return {
    model: "bytedance/seedance-2.0",
    prompt: input.prompt,
    resolution: input.resolution,
    duration: input.duration,
    aspect_ratio: input.aspectRatio === "auto" ? "16:9" : input.aspectRatio,
    references: {
      images: imageUrls,
      videos: videoUrls,
      audios: audioUrls
    }
  };
}

export async function createSeedanceTask(input: CreateTaskInput) {
  if (provider === "mock") {
    return {
      providerTaskId: `mock_${Date.now()}`,
      status: "succeeded" as const,
      outputVideoUrl: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"
    };
  }

  if (!apiKey) throw new Error("SEEDANCE_API_KEY is not set.");

  const response = await fetch("https://openrouter.ai/api/v1/videos", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildSeedancePayload(input))
  });

  const body = await response.json().catch(() => ({}));
  console.log("OpenRouter createSeedanceTask response:", JSON.stringify(body));
  if (!response.ok) {
    throw new Error(`OpenRouter API error ${response.status}: ${JSON.stringify(body)}`);
  }

  return {
    providerTaskId: String(body.id ?? body.task_id ?? ""),
    status: normalizeProviderStatus(body.status ?? body.state ?? "processing"),
    outputVideoUrl: body.video_url ?? body.output_url ?? body.url ?? undefined
  };
}

export async function getSeedanceTask(providerTaskId: string) {
  if (provider === "mock") {
    return {
      status: "succeeded" as const,
      outputVideoUrl: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"
    };
  }

  if (!apiKey) throw new Error("SEEDANCE_API_KEY is not set.");

  const response = await fetch(`https://openrouter.ai/api/v1/videos/${encodeURIComponent(providerTaskId)}`, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    }
  });

  const body = await response.json().catch(() => ({}));
  console.log("OpenRouter getSeedanceTask response:", JSON.stringify(body));
  if (!response.ok) {
    throw new Error(`OpenRouter API error ${response.status}: ${JSON.stringify(body)}`);
  }

  return {
    status: normalizeProviderStatus(body.status ?? body.state ?? "processing"),
    outputVideoUrl: body.video_url ?? body.output_url ?? body.url ?? undefined
  };
}

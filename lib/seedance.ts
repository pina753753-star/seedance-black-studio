import { z } from "zod";
import type { CreateTaskInput } from "./types";
import { normalizeProviderStatus } from "./store";

const provider = process.env.SEEDANCE_PROVIDER ?? "mock";

const baseUrl = process.env.SEEDANCE_API_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3";
const createPath = process.env.SEEDANCE_CREATE_PATH ?? "/contents/generations/tasks";
const queryPath = process.env.SEEDANCE_QUERY_PATH ?? "/contents/generations/tasks/{task_id}";
const model = process.env.SEEDANCE_MODEL ?? "seedance-2.0";

const seedanceResponseSchema = z.object({
  id: z.string().optional(),
  task_id: z.string().optional(),
  status: z.string().optional(),
  state: z.string().optional(),
  video_url: z.string().optional(),
  output_video_url: z.string().optional(),
  url: z.string().optional(),
  data: z.any().optional()
}).passthrough();

export function buildSeedancePayload(input: CreateTaskInput) {
  const imageUrls = input.assets.filter((a) => a.type === "image" && a.url).map((a) => a.url);
  const videoUrls = input.assets.filter((a) => a.type === "video" && a.url).map((a) => a.url);
  const audioUrls = input.assets.filter((a) => a.type === "audio" && a.url).map((a) => a.url);

  return {
    model,
    prompt: input.prompt,
    mode: input.mode,
    resolution: input.resolution,
    duration: input.duration,
    aspect_ratio: input.aspectRatio,
    with_audio: true,
    real_person: input.realPerson,
    return_last_frame: input.returnLastFrame,
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

  const apiKey = process.env.SEEDANCE_API_KEY;
  if (!apiKey) {
    throw new Error("SEEDANCE_API_KEY is not set.");
  }

  const response = await fetch(`${baseUrl}${createPath}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildSeedancePayload(input))
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Seedance API error ${response.status}: ${JSON.stringify(body)}`);
  }

  const parsed = seedanceResponseSchema.parse(body);
  const data = parsed.data ?? parsed;

  return {
    providerTaskId: String(data.id ?? data.task_id ?? parsed.id ?? parsed.task_id),
    status: normalizeProviderStatus(data.status ?? data.state ?? parsed.status ?? parsed.state),
    outputVideoUrl: data.video_url ?? data.output_video_url ?? data.url ?? parsed.video_url ?? parsed.output_video_url ?? parsed.url
  };
}

export async function getSeedanceTask(providerTaskId: string) {
  if (provider === "mock") {
    return {
      status: "succeeded" as const,
      outputVideoUrl: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"
    };
  }

  const apiKey = process.env.SEEDANCE_API_KEY;
  if (!apiKey) {
    throw new Error("SEEDANCE_API_KEY is not set.");
  }

  const path = queryPath.replace("{task_id}", encodeURIComponent(providerTaskId));
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Seedance API error ${response.status}: ${JSON.stringify(body)}`);
  }

  const parsed = seedanceResponseSchema.parse(body);
  const data = parsed.data ?? parsed;

  return {
    status: normalizeProviderStatus(data.status ?? data.state ?? parsed.status ?? parsed.state),
    outputVideoUrl: data.video_url ?? data.output_video_url ?? data.url ?? parsed.video_url ?? parsed.output_video_url ?? parsed.url
  };
}

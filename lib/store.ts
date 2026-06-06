import { createClient } from "@supabase/supabase-js";
import type { GenerationTask, TaskStatus } from "./types";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function addTask(task: GenerationTask) {
  const supabase = getSupabase();
  await supabase.from("generation_tasks").insert({
    id: task.id,
    user_id: task.userId ?? "00000000-0000-0000-0000-000000000000",
    mode: task.mode === "text" ? "text_to_video" : task.mode === "image" ? "image_to_video" : "reference_to_video",
    model: "seedance-2.0",
    prompt: task.prompt,
    resolution: task.resolution,
    duration_seconds: task.duration,
    aspect_ratio: task.aspectRatio,
    credit_cost: task.costCredits,
    status: "queued"
  });
  return task;
}

export async function getTask(id: string): Promise<GenerationTask | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("generation_tasks")
    .select("*")
    .eq("id", id)
    .single();
  if (!data) return null;
  return dbRowToTask(data);
}

export async function readTasks(): Promise<GenerationTask[]> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("generation_tasks")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  return (data ?? []).map(dbRowToTask);
}

export async function updateTask(
  id: string,
  patch: Partial<Pick<GenerationTask, "status" | "outputVideoUrl" | "error" | "providerTaskId">>
) {
  const supabase = getSupabase();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status) update.status = normalizeToDbStatus(patch.status);
  if (patch.outputVideoUrl) update.output_url = patch.outputVideoUrl;
  if (patch.error) update.error_message = patch.error;
  if (patch.providerTaskId) update.api_task_id = patch.providerTaskId;

  const { data } = await supabase
    .from("generation_tasks")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (!data) return null;
  return dbRowToTask(data);
}

function dbRowToTask(row: Record<string, unknown>): GenerationTask {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    mode: row.mode === "text_to_video" ? "text" : row.mode === "image_to_video" ? "image" : "reference",
    prompt: row.prompt as string,
    resolution: row.resolution as string,
    duration: row.duration_seconds as number,
    aspectRatio: row.aspect_ratio as string,
    costCredits: row.credit_cost as number,
    status: normalizeProviderStatus(row.status),
    providerTaskId: row.api_task_id as string | undefined,
    outputVideoUrl: row.output_url as string | undefined,
    watermarkedUrl: row.watermarked_url as string | undefined,
    error: row.error_message as string | undefined,
    assets: [],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  } as GenerationTask;
}

function normalizeToDbStatus(status: string): string {
  if (status === "succeeded") return "completed";
  if (status === "queued") return "queued";
  if (status === "processing") return "processing";
  if (status === "failed") return "failed";
  return "queued";
}

export function normalizeProviderStatus(value: unknown): TaskStatus {
  const status = String(value ?? "").toLowerCase();
  if (["succeeded", "success", "completed", "done"].includes(status)) return "succeeded";
  if (["failed", "error", "cancelled", "canceled"].includes(status)) return "failed";
  if (["processing", "running", "queued", "pending", "created", "draft"].includes(status)) return "processing";
  return "processing";
}

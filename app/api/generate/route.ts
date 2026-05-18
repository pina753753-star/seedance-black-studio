import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import type { AspectRatio, CreateTaskInput, Mode, Resolution, UploadedAsset } from "@/lib/types";
import { calculateCredits } from "@/lib/cost";
import { createSeedanceTask } from "@/lib/seedance";
import { addTask, updateTask } from "@/lib/store";

export const runtime = "nodejs";

const imageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const videoTypes = new Set(["video/mp4", "video/quicktime"]);
const audioTypes = new Set(["audio/mpeg", "audio/wav", "audio/mp3", "audio/x-wav"]);

function getAssetType(file: File): UploadedAsset["type"] | null {
  if (imageTypes.has(file.type)) return "image";
  if (videoTypes.has(file.type)) return "video";
  if (audioTypes.has(file.type)) return "audio";
  return null;
}

function hasSupabase() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function uploadFileToSupabase(file: File, taskId: string) {
  if (!hasSupabase()) {
    return undefined;
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? "seedance-assets";
  const ext = file.name.split(".").pop() ?? "bin";
  const objectPath = `${taskId}/${randomUUID()}.${ext}`;

  const buffer = Buffer.from(await file.arrayBuffer());

  const { error } = await supabase.storage.from(bucket).upload(objectPath, buffer, {
    contentType: file.type,
    upsert: false
  });

  if (error) {
    throw new Error(`Supabase upload failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(objectPath);
  return data.publicUrl;
}

function readString(formData: FormData, key: string, fallback = "") {
  const value = formData.get(key);
  return typeof value === "string" ? value : fallback;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const id = randomUUID();

  const mode = readString(formData, "mode", "text") as Mode;
  const prompt = readString(formData, "prompt", "").trim();
  const resolution = readString(formData, "resolution", "480p") as Resolution;
  const duration = Number(readString(formData, "duration", "5"));
  const aspectRatio = readString(formData, "aspectRatio", "auto") as AspectRatio;
  const realPerson = readString(formData, "realPerson", "false") === "true";
  const returnLastFrame = readString(formData, "returnLastFrame", "false") === "true";

  if (!prompt) {
    return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
  }

  const files = formData.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);

  if (mode === "image" && files.filter((file) => getAssetType(file) === "image").length < 1) {
    return NextResponse.json({ error: "Image mode requires one image." }, { status: 400 });
  }

  if (mode === "reference" && files.length < 1) {
    return NextResponse.json({ error: "Reference mode requires at least one reference file." }, { status: 400 });
  }

  const assets: UploadedAsset[] = [];
  for (const file of files) {
    const assetType = getAssetType(file);
    if (!assetType) continue;

    assets.push({
      id: randomUUID(),
      name: file.name,
      type: assetType,
      size: file.size,
      url: await uploadFileToSupabase(file, id)
    });
  }

  const input: CreateTaskInput = {
    mode,
    prompt,
    resolution,
    duration,
    aspectRatio,
    realPerson,
    returnLastFrame,
    assets
  };

  const now = new Date().toISOString();
  const task = await addTask({
    ...input,
    id,
    status: "queued",
    costCredits: calculateCredits(resolution, duration),
    createdAt: now,
    updatedAt: now
  });

  try {
    const providerTask = await createSeedanceTask(input);
    const updated = await updateTask(task.id, {
      providerTaskId: providerTask.providerTaskId,
      status: providerTask.status,
      outputVideoUrl: providerTask.outputVideoUrl
    });

    return NextResponse.json({ task: updated ?? task });
  } catch (error) {
    const updated = await updateTask(task.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error."
    });

    return NextResponse.json({ task: updated ?? task }, { status: 502 });
  }
}

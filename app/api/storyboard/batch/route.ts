import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { calculateCredits } from "@/lib/cost";
import type { Resolution } from "@/lib/types";

export const runtime = "nodejs";

const DEFAULT_RESOLUTION: Resolution = "720p";
const DEFAULT_ASPECT_RATIO = "16:9";
const MODEL = "bytedance/seedance-2.0";

type Cut = {
  cut_number: number;
  duration?: number;
  prompt: string;
  camera?: string;
  content?: string;
};

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function POST(request: Request) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 500 });
  }

  let body: { cuts?: Cut[]; referenceImageUrl?: string; userId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { cuts, referenceImageUrl, userId } = body;

  if (!Array.isArray(cuts) || cuts.length === 0) {
    return NextResponse.json({ error: "cuts must be a non-empty array." }, { status: 400 });
  }
  if (!userId) {
    return NextResponse.json({ error: "userId is required." }, { status: 400 });
  }

  const storyboardId = randomUUID();
  const supabase = getSupabase();
  const now = new Date().toISOString();

  const rows = cuts.map((cut) => {
    const duration = Math.max(1, Math.min(15, Number(cut.duration ?? 5)));
    const creditCost = calculateCredits(DEFAULT_RESOLUTION, duration);
    const mode = referenceImageUrl ? "reference_to_video" : "text_to_video";

    return {
      id: randomUUID(),
      user_id: userId,
      storyboard_id: storyboardId,
      mode,
      model: MODEL,
      prompt: String(cut.prompt ?? "").trim(),
      resolution: DEFAULT_RESOLUTION,
      duration_seconds: duration,
      aspect_ratio: DEFAULT_ASPECT_RATIO,
      credit_cost: creditCost,
      status: "queued",
      // Store camera/content notes in error_message temporarily via settings JSON;
      // these are informational and not used by the generation pipeline.
      settings: {
        cut_number: cut.cut_number,
        camera: cut.camera ?? null,
        content: cut.content ?? null,
        ...(referenceImageUrl ? { reference_url: referenceImageUrl } : {})
      },
      created_at: now,
      updated_at: now
    };
  });

  const { data, error } = await supabase
    .from("generation_tasks")
    .insert(rows)
    .select("id,storyboard_id,status,prompt,duration_seconds,credit_cost");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const taskIds = (data ?? []).map((r: { id: string }) => r.id);
  const totalCredits = rows.reduce((sum, r) => sum + r.credit_cost, 0);

  return NextResponse.json({
    ok: true,
    storyboardId,
    taskIds,
    taskCount: taskIds.length,
    totalCredits,
    tasks: data
  });
}

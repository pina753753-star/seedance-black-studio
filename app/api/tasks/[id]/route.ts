import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSeedanceTask } from "@/lib/seedance";
import { getTask, updateTask } from "@/lib/store";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

async function deductCredits(userId: string, amount: number) {
  if (amount <= 0) return;
  const supabase = getSupabase();

  const { data: bal, error } = await supabase
    .from("credit_balances")
    .select("subscription_credits,free_credits,purchased_credits")
    .eq("user_id", userId)
    .single();

  if (error || !bal) return;

  let remaining = amount;
  const fromSub = Math.min(remaining, Number(bal.subscription_credits ?? 0)); remaining -= fromSub;
  const fromFree = Math.min(remaining, Number(bal.free_credits ?? 0)); remaining -= fromFree;
  const fromPurchased = Math.min(remaining, Number(bal.purchased_credits ?? 0));

  await supabase.from("credit_balances").update({
    subscription_credits: Number(bal.subscription_credits ?? 0) - fromSub,
    free_credits: Number(bal.free_credits ?? 0) - fromFree,
    purchased_credits: Number(bal.purchased_credits ?? 0) - fromPurchased,
    updated_at: new Date().toISOString()
  }).eq("user_id", userId);
}

export async function GET(_: Request, context: { params: { id: string } }) {
  const task = await getTask(context.params.id);

  if (!task) {
    return NextResponse.json({ error: "Task not found." }, { status: 404 });
  }

  if (task.providerTaskId && task.status !== "succeeded" && task.status !== "failed") {
    try {
      const providerState = await getSeedanceTask(task.providerTaskId);
      const updated = await updateTask(task.id, providerState);

      if (providerState.status === "succeeded" && task.userId && task.costCredits > 0) {
        await deductCredits(task.userId, task.costCredits);
      }

      return NextResponse.json({ task: updated ?? task });
    } catch (error) {
      const updated = await updateTask(task.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error."
      });
      return NextResponse.json({ task: updated ?? task });
    }
  }

  return NextResponse.json({ task });
}

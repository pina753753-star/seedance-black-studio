import { NextResponse } from "next/server";
import { getSeedanceTask } from "@/lib/seedance";
import { getTask, updateTask } from "@/lib/store";

export async function GET(_: Request, context: { params: { id: string } }) {
  const task = await getTask(context.params.id);

  if (!task) {
    return NextResponse.json({ error: "Task not found." }, { status: 404 });
  }

  if (task.providerTaskId && task.status !== "succeeded" && task.status !== "failed") {
    try {
      const providerState = await getSeedanceTask(task.providerTaskId);
      const updated = await updateTask(task.id, providerState);
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

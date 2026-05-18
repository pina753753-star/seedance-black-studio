import { NextResponse } from "next/server";
import { readTasks } from "@/lib/store";

export async function GET() {
  const tasks = await readTasks();
  return NextResponse.json({ tasks });
}

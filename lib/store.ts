import { promises as fs } from "fs";
import path from "path";
import type { GenerationTask, TaskStatus } from "./types";

const dataDir = path.join(process.cwd(), ".local-data");
const taskFile = path.join(dataDir, "tasks.json");

async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(taskFile);
  } catch {
    await fs.writeFile(taskFile, "[]", "utf-8");
  }
}

export async function readTasks(): Promise<GenerationTask[]> {
  await ensureStore();
  const raw = await fs.readFile(taskFile, "utf-8");
  return JSON.parse(raw) as GenerationTask[];
}

export async function writeTasks(tasks: GenerationTask[]) {
  await ensureStore();
  await fs.writeFile(taskFile, JSON.stringify(tasks, null, 2), "utf-8");
}

export async function addTask(task: GenerationTask) {
  const tasks = await readTasks();
  tasks.unshift(task);
  await writeTasks(tasks);
  return task;
}

export async function getTask(id: string) {
  const tasks = await readTasks();
  return tasks.find((task) => task.id === id) ?? null;
}

export async function updateTask(
  id: string,
  patch: Partial<Pick<GenerationTask, "status" | "outputVideoUrl" | "error" | "providerTaskId">>
) {
  const tasks = await readTasks();
  const index = tasks.findIndex((task) => task.id === id);
  if (index === -1) return null;

  tasks[index] = {
    ...tasks[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };

  await writeTasks(tasks);
  return tasks[index];
}

export function normalizeProviderStatus(value: unknown): TaskStatus {
  const status = String(value ?? "").toLowerCase();

  if (["succeeded", "success", "completed", "done"].includes(status)) return "succeeded";
  if (["failed", "error", "cancelled", "canceled"].includes(status)) return "failed";
  if (["processing", "running", "queued", "pending", "created"].includes(status)) return "processing";

  return "processing";
}

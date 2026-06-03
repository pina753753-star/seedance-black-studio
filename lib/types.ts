export type Mode = "text" | "image" | "reference";

export type Resolution = "480p" | "720p" | "1080p";
export type AspectRatio = "auto" | "16:9" | "9:16" | "4:3" | "3:4" | "21:9" | "1:1";
export type TaskStatus = "queued" | "processing" | "succeeded" | "failed";

export type UploadedAsset = {
  id: string;
  name: string;
  type: "image" | "video" | "audio";
  url?: string;
  size?: number;
};

export type CreateTaskInput = {
  mode: Mode;
  prompt: string;
  resolution: Resolution;
  duration: number;
  aspectRatio: AspectRatio;
  realPerson: boolean;
  returnLastFrame: boolean;
  assets: UploadedAsset[];
};

export type GenerationTask = CreateTaskInput & {
  id: string;
  userId?: string;
  providerTaskId?: string;
  status: TaskStatus;
  outputVideoUrl?: string;
  error?: string;
  costCredits: number;
  createdAt: string;
  updatedAt: string;
};

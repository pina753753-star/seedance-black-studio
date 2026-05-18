import type { Resolution } from "./types";

const COST_PER_SECOND: Record<Resolution, number> = {
  "480p": 6,
  "720p": 12,
  "1080p": 30
};

export function calculateCredits(resolution: Resolution, duration: number) {
  return COST_PER_SECOND[resolution] * duration;
}

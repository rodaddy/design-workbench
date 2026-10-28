import { z } from "zod";

export const projectBaselineSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  revision: z.number().int().positive(),
  sourcePath: z.string().min(1),
  snapshotPath: z.string().min(1),
  contentHash: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
  byteCount: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1),
  createdAt: z.string().min(1),
});

export const studioProjectSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  canonicalSourcePath: z.string().min(1),
  runtimePath: z.string().min(1),
  status: z.enum(["active", "archived"]),
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  baselines: z.array(projectBaselineSchema),
});

export const studioRoundSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  sequence: z.number().int().positive(),
  stage: z.enum(["wide-net", "refinement", "assets", "tuning"]),
  comparisonId: z.string().nullable(),
  status: z.enum(["draft", "running", "completed", "cancelled"]),
  prompt: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const studioMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().nullable(),
  sequence: z.number().int().positive(),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1),
});

export const studioSessionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  roundId: z.string().nullable(),
  status: z.enum(["open", "completed", "failed", "cancelled"]),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  messages: z.array(studioMessageSchema),
});

export const generationJobSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  roundId: z.string().nullable(),
  comparisonId: z.string().nullable(),
  directionId: z.string().nullable(),
  kind: z.enum(["wide-net", "refinement", "assets", "revision"]),
  engine: z.enum(["impeccable", "taste"]).nullable(),
  position: z.number().int().nonnegative(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  cancelRequested: z.boolean(),
  artifactPath: z.string().nullable(),
  variantId: z.string().nullable(),
  sessionId: z.string().nullable(),
  runId: z.string().nullable(),
  prompt: z.string(),
  payload: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export type StudioProject = z.infer<typeof studioProjectSchema>;
export type StudioRound = z.infer<typeof studioRoundSchema>;
export type StudioSession = z.infer<typeof studioSessionSchema>;
export type GenerationJob = z.infer<typeof generationJobSchema>;

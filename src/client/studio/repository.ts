import { z } from "zod";
import {
  generationJobSchema,
  studioProjectSchema,
  studioRoundSchema,
  studioSessionSchema,
  type GenerationJob,
  type StudioProject,
  type StudioRound,
  type StudioSession,
} from "./types";

export interface CreateStudioProjectInput {
  slug: string;
  title: string;
  sourcePath: string;
  idempotencyKey: string;
}

export interface AgentReferenceInput {
  title: string;
  sourceUrl?: string;
  aestheticFamily?: string;
  vocabulary?: string[];
  observed?: string;
  limitation?: string;
  assetPaths?: string[];
}

export class StudioRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StudioRepositoryError";
  }
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const error = z
      .object({ error: z.object({ code: z.string(), message: z.string() }) })
      .safeParse(body);
    throw new StudioRepositoryError(
      error.success ? error.data.error.code : "studio_request_failed",
      error.success
        ? error.data.error.message
        : `Studio request failed (${response.status})`,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new StudioRepositoryError(
      "studio_contract_invalid",
      "Studio API response does not match the client contract",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export interface StudioRepository {
  listProjects(): Promise<StudioProject[]>;
  createProject(input: CreateStudioProjectInput): Promise<StudioProject>;
  getProject(id: string): Promise<StudioProject>;
  createBaseline(
    projectId: string,
  ): Promise<StudioProject["baselines"][number]>;
  listRounds(projectId: string): Promise<StudioRound[]>;
  createRound(
    projectId: string,
    input: {
      stage: StudioRound["stage"];
      prompt: string;
      payload: Record<string, unknown>;
      comparisonId: string | null;
      parentRoundId: string | null;
      idempotencyKey: string;
    },
  ): Promise<StudioRound>;
  createRefinement(
    comparisonId: string,
    directionId: string,
  ): Promise<StudioRound>;
  configureDirections(
    projectId: string,
    roundId: string,
    directions: Array<{
      title: string;
      aestheticFamily: string;
      referenceIds: string[];
    }>,
  ): Promise<void>;
  createSession(
    projectId: string,
    roundId?: string | null,
  ): Promise<StudioSession>;
  sendMessage(
    sessionId: string,
    input: {
      message: string;
      mode: "review" | "build";
      brief?: string;
      round?: string;
      phase?: string;
      references?: AgentReferenceInput[];
      tweaks?: Record<string, unknown>;
    },
  ): Promise<StudioSession>;
  listJobs(comparisonId: string): Promise<GenerationJob[]>;
  enqueueMissingProofs(comparisonId: string): Promise<GenerationJob[]>;
  cancelJob(jobId: string): Promise<GenerationJob>;
}

export class HttpStudioRepository implements StudioRepository {
  listProjects() {
    return request("/api/projects", z.array(studioProjectSchema));
  }

  createProject(input: CreateStudioProjectInput) {
    return request("/api/projects", studioProjectSchema, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  getProject(id: string) {
    return request(
      `/api/projects/${encodeURIComponent(id)}`,
      studioProjectSchema,
    );
  }

  createBaseline(projectId: string) {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/baselines`,
      studioProjectSchema.shape.baselines.element,
      {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      },
    );
  }

  listRounds(projectId: string) {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/rounds`,
      z.array(studioRoundSchema),
    );
  }

  createRound(
    projectId: string,
    input: {
      stage: StudioRound["stage"];
      prompt: string;
      payload: Record<string, unknown>;
      comparisonId: string | null;
      parentRoundId: string | null;
      idempotencyKey: string;
    },
  ) {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/rounds`,
      studioRoundSchema,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  createRefinement(comparisonId: string, directionId: string) {
    return request(
      `/api/comparisons/${encodeURIComponent(comparisonId)}/directions/${encodeURIComponent(directionId)}/refinements`,
      studioRoundSchema,
      {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      },
    );
  }

  async configureDirections(
    projectId: string,
    roundId: string,
    directions: Array<{
      title: string;
      aestheticFamily: string;
      referenceIds: string[];
    }>,
  ) {
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/rounds/${encodeURIComponent(roundId)}/directions`,
      z.object({ ok: z.literal(true) }),
      { method: "PATCH", body: JSON.stringify(directions) },
    );
  }

  createSession(projectId: string, roundId: string | null = null) {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/agent-sessions`,
      studioSessionSchema,
      {
        method: "POST",
        body: JSON.stringify({
          roundId,
          metadata: { purpose: "design-studio" },
          idempotencyKey: crypto.randomUUID(),
        }),
      },
    );
  }

  sendMessage(
    sessionId: string,
    input: {
      message: string;
      mode: "review" | "build";
      brief?: string;
      round?: string;
      phase?: string;
      references?: AgentReferenceInput[];
      tweaks?: Record<string, unknown>;
    },
  ) {
    return request(
      `/api/agent-sessions/${encodeURIComponent(sessionId)}/messages`,
      studioSessionSchema,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  listJobs(comparisonId: string) {
    return request(
      `/api/comparisons/${encodeURIComponent(comparisonId)}/jobs`,
      z.array(generationJobSchema),
    );
  }

  async enqueueMissingProofs(comparisonId: string) {
    const result = await request(
      `/api/comparisons/${encodeURIComponent(comparisonId)}/jobs`,
      z.object({
        enqueued: z.array(generationJobSchema),
        jobs: z.array(generationJobSchema),
      }),
      { method: "POST", body: JSON.stringify({}) },
    );
    return result.jobs;
  }

  cancelJob(jobId: string) {
    return request(
      `/api/jobs/${encodeURIComponent(jobId)}/cancel`,
      generationJobSchema,
      { method: "POST", body: JSON.stringify({}) },
    );
  }
}

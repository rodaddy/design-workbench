import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { z } from "zod";

import { buildAgentContext } from "./agent-context";
import { LocalAgentError, LocalAgentRunner } from "./agent-runner";
import {
  ComparisonError,
  createComparison,
  getComparison,
  listComparisons,
  updateComparison,
} from "./comparisons";
import { generateComparisonVariant, GenerationError } from "./generation";
import { GenerationQueue } from "./job-queue";
import { GenerationJobError, GenerationJobStore } from "./jobs";
import { applyTweakRevision, listRevisions } from "./artifact-revisions";
import {
  generateRefinementOption,
  refinementArtifactPath,
  resolveRefinementParent,
  REFINEMENT_LENSES,
} from "./refinements";
import {
  buildHandoffPacket,
  HandoffError,
  renderHandoffMarkdown,
} from "./handoff";
import { TweakDecisionError, TweakDecisionStore } from "./tweak-decisions";
import {
  ProjectError,
  StudioProjectStore,
  type ProjectStorageConfig,
} from "./projects";
import { StudioError, StudioService } from "./studio";
import { LibraryStore, StoreError } from "./store";
import {
  extractSingleFileMultipart,
  readBoundedRequestBody,
  storeContentAddressedUpload,
  UploadError,
} from "./uploads";
import { registerVariant, VariantRegistrationError } from "./variants";

const JSON_LIMIT = 1024 * 1024;
const UPLOAD_LIMIT = 10 * 1024 * 1024;
const identifier = z.string().trim().min(1).max(200);
const origin = z
  .string()
  .url()
  .transform((value, context) => {
    const parsed = new URL(value);
    if (parsed.origin !== value.replace(/\/$/, "")) {
      context.addIssue({
        code: "custom",
        message: "Origin must not include a path",
      });
      return z.NEVER;
    }
    return parsed.origin;
  });
const configSchema = z
  .object({
    database: z.custom<Database>(
      (value) => typeof value === "object" && value !== null,
    ),
    assetRoot: z.string().trim().min(1),
    generatedVariantsRoot: z.string().trim().min(1),
    allowedOrigins: z.array(origin).min(1),
    projectStorage: z
      .object({
        allowedSourceRoots: z.array(z.string().trim().min(1)).min(1),
        runtimeRoot: z.string().trim().min(1),
      })
      .strict()
      .optional(),
    agentRunner: z
      .custom<LocalAgentRunner>((value) => value instanceof LocalAgentRunner)
      .optional(),
    workbenchRoot: z.string().trim().min(1).default("."),
    generation: z
      .object({
        model: z.string().trim().min(1).max(100),
        effort: z.enum(["low", "medium", "high"]),
        // Each job is a full local agent run, so the default stays low.
        concurrency: z.number().int().min(1).max(8).default(2),
      })
      .strict()
      .default({ model: "claude-opus-5", effort: "high", concurrency: 2 }),
  })
  .strict();
const uploadMetadataSchema = z
  .object({
    role: z.string().trim().min(1).max(100).default("reference"),
    motionTimestampMs: z.coerce
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null),
  })
  .strict();
const comparisonCreateSchema = z
  .object({
    brief: z.string().trim().min(1),
    directions: z.number().int().min(1).max(5),
  })
  .strict();
const variantInputSchema = z
  .object({
    comparison: identifier,
    direction: identifier,
    engine: z.enum(["impeccable", "taste"]),
    path: z.string().trim().min(1),
    viewport: z.record(z.string(), z.json()).optional(),
    metadata: z.record(z.string(), z.json()).optional(),
  })
  .strict();
const agentReferenceSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    sourceUrl: z.string().url().optional(),
    aestheticFamily: z.string().max(300).optional(),
    vocabulary: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
    observed: z.string().max(20_000).optional(),
    limitation: z.string().max(20_000).optional(),
    assetPaths: z.array(z.string().trim().min(1).max(2_000)).max(12).optional(),
  })
  .strict();
const agentMessageSchema = z
  .object({
    message: z.string().trim().min(1).max(100_000),
    mode: z.enum(["review", "build"]).default("review"),
    brief: z.string().max(100_000).default(""),
    round: z.string().max(50_000).default(""),
    phase: z.string().trim().max(120).default("discussion"),
    references: z.array(agentReferenceSchema).max(20).default([]),
    tweaks: z.record(z.string(), z.json()).default({}),
  })
  .strict();

export interface ApiConfig {
  database: Database;
  assetRoot: string;
  generatedVariantsRoot: string;
  allowedOrigins: string[];
  projectStorage?: ProjectStorageConfig;
  agentRunner?: LocalAgentRunner;
  workbenchRoot?: string;
  generation?: {
    model: string;
    effort: "low" | "medium" | "high";
    concurrency?: number;
  };
}

type ErrorBody = {
  error: { code: string; message: string; issues?: unknown };
};

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers });
}

function failure(
  status: number,
  code: string,
  message: string,
  issues?: unknown,
): Response {
  const body: ErrorBody = {
    error: { code, message, ...(issues === undefined ? {} : { issues }) },
  };
  return json(body, status);
}

async function parseJson(request: Request): Promise<unknown> {
  const bytes = await readBoundedRequestBody(request, JSON_LIMIT);
  if (bytes.byteLength === 0) {
    throw new ApiInputError("invalid_json", "JSON request body is required");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiInputError(
      "invalid_json",
      "Request body must be valid UTF-8 JSON",
    );
  }
}

class ApiInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
  }
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiInputError(
      "invalid_input",
      "Request input is invalid",
      result.error.issues,
    );
  }
  return result.data;
}

function statusForError(error: unknown): number {
  if (error instanceof StoreError) {
    switch (error.code) {
      case "not_found":
        return 404;
      case "conflict":
        return 409;
      case "data_invalid":
        return 500;
      case "invalid":
        return 400;
    }
  }
  if (error instanceof ComparisonError) {
    switch (error.code) {
      case "BRIEF_NOT_FOUND":
      case "COMPARISON_NOT_FOUND":
        return 404;
      case "COMPARISON_CONFLICT":
      case "COMPARISON_DIRECTORY_EXISTS":
        return 409;
      case "INVALID_COMPARISON_INPUT":
        return 400;
      case "BRIEF_READ_FAILED":
      case "COMPARISON_CREATE_FAILED":
      case "COMPARISON_DATA_INVALID":
      case "COMPARISON_ROLLBACK_FAILED":
      case "INVALID_GENERATED_PATH":
        return 500;
      default:
        return 500;
    }
  }
  if (error instanceof VariantRegistrationError) {
    switch (error.code) {
      case "COMPARISON_NOT_FOUND":
      case "DIRECTION_NOT_FOUND":
        return 404;
      case "COMPARISON_CONFLICT":
      case "DIRECTION_CONFLICT":
        return 409;
      case "INVALID_VARIANT_INPUT":
      case "INVALID_VARIANT_PATH":
      case "VARIANT_INDEX_MISSING":
      case "VARIANT_METADATA_TOO_LARGE":
        return 400;
      case "INVALID_GENERATED_ROOT":
      case "VARIANT_REGISTER_FAILED":
        return 500;
      default:
        return 500;
    }
  }
  if (error instanceof UploadError) {
    switch (error.code) {
      case "BODY_TOO_LARGE":
        return 413;
      case "INVALID_STORAGE_PATH":
      case "STORAGE_IO_ERROR":
        return 500;
      default:
        return 400;
    }
  }
  if (error instanceof ProjectError) {
    if (error.code === "PROJECT_NOT_FOUND") return 404;
    if (error.code === "PROJECT_CONFLICT") return 409;
    if (
      error.code === "PROJECT_DATA_INVALID" ||
      error.code === "PROJECT_RUNTIME_PATH_INVALID" ||
      error.code === "PROJECT_SNAPSHOT_IO_ERROR"
    )
      return 500;
    return 400;
  }
  if (error instanceof StudioError) {
    if (error.code === "STUDIO_NOT_FOUND") return 404;
    if (error.code === "STUDIO_CONFLICT") return 409;
    if (error.code === "STUDIO_DATA_INVALID") return 500;
    return 400;
  }
  if (error instanceof GenerationError) {
    if (error.code === "GENERATION_NOT_FOUND") return 404;
    if (error.code === "GENERATION_CONFLICT") return 409;
    if (error.code === "GENERATION_INVALID_PATH") return 400;
    return 500;
  }
  if (error instanceof TweakDecisionError) {
    if (error.code === "TWEAK_NOT_FOUND") return 404;
    if (error.code === "TWEAK_CONFLICT") return 409;
    if (error.code === "TWEAK_DATA_INVALID") return 500;
    return 400;
  }
  if (error instanceof GenerationJobError) {
    if (error.code === "JOB_NOT_FOUND") return 404;
    if (error.code === "JOB_CONFLICT") return 409;
    if (error.code === "JOB_DATA_INVALID") return 500;
    return 400;
  }
  if (error instanceof HandoffError) {
    if (error.code === "HANDOFF_NOT_FOUND") return 404;
    return 500;
  }
  if (error instanceof LocalAgentError) {
    if (error.code === "AGENT_ACTIVE") return 409;
    if (error.code === "AGENT_TIMEOUT") return 504;
    if (error.code === "AGENT_FAILED") return 502;
    return 400;
  }
  if (error instanceof ApiInputError) return 400;
  return 500;
}

function responseForError(error: unknown): Response {
  const status = statusForError(error);
  if (error instanceof StoreError) {
    return failure(
      status,
      error.code,
      `Store request failed: ${error.code}`,
      error.details,
    );
  }
  if (
    error instanceof ComparisonError ||
    error instanceof VariantRegistrationError ||
    error instanceof UploadError ||
    error instanceof ProjectError ||
    error instanceof StudioError ||
    error instanceof GenerationError ||
    error instanceof GenerationJobError ||
    error instanceof TweakDecisionError ||
    error instanceof HandoffError ||
    error instanceof LocalAgentError
  ) {
    const cause = error.cause;
    const issues = cause instanceof z.ZodError ? cause.issues : undefined;
    return failure(status, error.code.toLowerCase(), error.message, issues);
  }
  if (error instanceof ApiInputError) {
    return failure(status, error.code, error.message, error.issues);
  }
  console.error("API request failed", error);
  return failure(500, "internal_error", "The request could not be completed");
}

function queryObject(url: URL): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key in result)
      throw new ApiInputError(
        "invalid_query",
        "Duplicate query parameters are not allowed",
      );
    result[key] = value;
  }
  return result;
}

function decodeIdentifier(value: string): string {
  try {
    return parsed(identifier, decodeURIComponent(value));
  } catch (error) {
    if (error instanceof ApiInputError) throw error;
    throw new ApiInputError("invalid_path", "Path identifier is invalid");
  }
}

function withCors(response: Response, requestOrigin: string | null): Response {
  if (requestOrigin === null) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", requestOrigin);
  headers.set("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createApiFetchHandler(
  input: ApiConfig,
): (request: Request) => Promise<Response> {
  const config = configSchema.parse(input);
  const allowedOrigins = new Set(config.allowedOrigins);
  const store = new LibraryStore(config.database);
  const projectStore = config.projectStorage
    ? new StudioProjectStore(config.database, config.projectStorage)
    : undefined;
  const studio = projectStore ? new StudioService(config.database) : undefined;
  const jobStore = new GenerationJobStore(config.database);
  const tweakStore = new TweakDecisionStore(
    config.database,
    resolve(config.generatedVariantsRoot),
  );
  // Jobs left running by a previous process cannot be resumed, so they are
  // failed at startup instead of appearing active forever.
  jobStore.recoverInterrupted();

  // The queue executes generation out of band. Concurrency stays low because
  // each job is a full local agent run, and the executor resolves everything it
  // needs from the job row so a restart never depends on request state.
  // Bound to locals so the executor closure keeps the narrowed types.
  const projectStorage = config.projectStorage;
  const agentRunner = config.agentRunner;
  const queue =
    studio && projectStore && projectStorage && agentRunner
      ? new GenerationQueue(
          jobStore,
          async (job) => {
            if (job.kind === "refinement") {
              if (!job.roundId) {
                throw new GenerationError(
                  "GENERATION_NOT_FOUND",
                  "Refinement job does not identify a round",
                );
              }
              const lens = REFINEMENT_LENSES[job.position];
              if (!lens) {
                throw new GenerationError(
                  "GENERATION_NOT_FOUND",
                  `Refinement job position ${job.position} has no lens`,
                );
              }
              const engine =
                job.engine === null ? undefined : (job.engine ?? undefined);
              return generateRefinementOption({
                database: config.database,
                studio,
                runner: agentRunner,
                generatedVariantsRoot: config.generatedVariantsRoot,
                workbenchRoot: resolve(config.workbenchRoot),
                projectId: job.projectId,
                target: resolveRefinementParent(
                  config.database,
                  job.roundId,
                  engine,
                ),
                lens,
                model: config.generation.model,
                effort: config.generation.effort,
              });
            }
            if (!job.comparisonId || !job.directionId || !job.engine) {
              throw new GenerationError(
                "GENERATION_NOT_FOUND",
                "Job does not identify a comparison direction and engine",
              );
            }
            const variant = await generateComparisonVariant({
              database: config.database,
              projects: projectStore,
              studio,
              runner: agentRunner,
              projectRuntimeRoot: projectStorage.runtimeRoot,
              generatedVariantsRoot: config.generatedVariantsRoot,
              workbenchRoot: resolve(config.workbenchRoot),
              comparisonId: job.comparisonId,
              directionId: job.directionId,
              engine: job.engine,
              model: config.generation.model,
              effort: config.generation.effort,
            });
            return {
              artifactPath: variant.artifactPath,
              variantId: variant.id,
            };
          },
          { concurrency: config.generation.concurrency },
        )
      : undefined;

  return async (request: Request): Promise<Response> => {
    let requestOrigin: string | null = null;
    // Availability guards (503) short-circuit the route table but must still
    // carry the same allowed-origin CORS headers as a normal API response, so
    // trusted browser callers can read the structured error.
    const unavailable = (code: string, message: string): Response =>
      withCors(failure(503, code, message), requestOrigin);
    try {
      const urlResult = z.string().url().safeParse(request.url);
      if (!urlResult.success)
        return failure(400, "invalid_url", "Request URL is invalid");
      const url = new URL(urlResult.data);
      requestOrigin = request.headers.get("origin");
      if (requestOrigin !== null && !allowedOrigins.has(requestOrigin)) {
        return failure(
          403,
          "origin_forbidden",
          "Request origin is not trusted",
        );
      }
      const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (unsafe && requestOrigin === null) {
        return failure(
          403,
          "origin_required",
          "Unsafe API requests require a trusted Origin",
        );
      }
      if (request.method === "OPTIONS") {
        if (requestOrigin === null)
          return failure(
            400,
            "origin_required",
            "CORS preflight requires an Origin",
          );
        return withCors(
          new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Headers":
                "Content-Type, X-Asset-Role, X-Motion-Timestamp-Ms",
              "Access-Control-Allow-Methods": "GET, HEAD, POST, PATCH, OPTIONS",
            },
          }),
          requestOrigin,
        );
      }

      const inspiration = /^\/api\/inspirations\/([^/]+)$/.exec(url.pathname);
      const inspirationAssets = /^\/api\/inspirations\/([^/]+)\/assets$/.exec(
        url.pathname,
      );
      const inspirationBrief = /^\/api\/inspirations\/([^/]+)\/brief$/.exec(
        url.pathname,
      );
      const category = /^\/api\/categories\/([^/]+)$/.exec(url.pathname);
      const brief = /^\/api\/briefs\/([^/]+)$/.exec(url.pathname);
      const comparison = /^\/api\/comparisons\/([^/]+)$/.exec(url.pathname);
      const comparisonGeneration =
        /^\/api\/comparisons\/([^/]+)\/directions\/([^/]+)\/engines\/(impeccable|taste)\/generate$/.exec(
          url.pathname,
        );
      const comparisonRefinement =
        /^\/api\/comparisons\/([^/]+)\/directions\/([^/]+)\/refinements$/.exec(
          url.pathname,
        );
      const comparisonJobs = /^\/api\/comparisons\/([^/]+)\/jobs$/.exec(
        url.pathname,
      );
      const roundGenerate = /^\/api\/rounds\/([^/]+)\/generate$/.exec(
        url.pathname,
      );
      const roundJobs = /^\/api\/rounds\/([^/]+)\/jobs$/.exec(url.pathname);
      const variantTweaks = /^\/api\/variants\/([^/]+)\/tweak-decisions$/.exec(
        url.pathname,
      );
      const variantRevisions = /^\/api\/variants\/([^/]+)\/revisions$/.exec(
        url.pathname,
      );
      const tweakDecision = /^\/api\/tweak-decisions\/([^/]+)$/.exec(
        url.pathname,
      );
      const tweakApply = /^\/api\/tweak-decisions\/([^/]+)\/apply$/.exec(
        url.pathname,
      );
      const projectHandoff = /^\/api\/projects\/([^/]+)\/handoff$/.exec(
        url.pathname,
      );
      const job = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
      const jobCancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(url.pathname);
      const project = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
      const projectBaselines = /^\/api\/projects\/([^/]+)\/baselines$/.exec(
        url.pathname,
      );
      const projectRounds = /^\/api\/projects\/([^/]+)\/rounds$/.exec(
        url.pathname,
      );
      const projectRoundDirections =
        /^\/api\/projects\/([^/]+)\/rounds\/([^/]+)\/directions$/.exec(
          url.pathname,
        );
      const projectSessions = /^\/api\/projects\/([^/]+)\/agent-sessions$/.exec(
        url.pathname,
      );
      const session = /^\/api\/agent-sessions\/([^/]+)$/.exec(url.pathname);
      const sessionMessages = /^\/api\/agent-sessions\/([^/]+)\/messages$/.exec(
        url.pathname,
      );
      let response: Response;

      if (url.pathname === "/api/health" && request.method === "GET") {
        response = json({ ok: true });
      } else if (
        url.pathname === "/api/inspirations" &&
        request.method === "GET"
      ) {
        response = json(store.listInspirations(queryObject(url)));
      } else if (
        url.pathname === "/api/inspirations" &&
        request.method === "POST"
      ) {
        response = json(store.createInspiration(await parseJson(request)), 201);
      } else if (inspiration && request.method === "GET") {
        response = json(
          store.getInspiration(decodeIdentifier(inspiration[1] ?? "")),
        );
      } else if (inspiration && request.method === "PATCH") {
        response = json(
          store.updateInspiration(
            decodeIdentifier(inspiration[1] ?? ""),
            await parseJson(request),
          ),
        );
      } else if (inspirationBrief && request.method === "POST") {
        response = json(
          store.createBriefFromInspiration(
            decodeIdentifier(inspirationBrief[1] ?? ""),
          ),
          201,
        );
      } else if (inspirationAssets && request.method === "POST") {
        const inspirationId = decodeIdentifier(inspirationAssets[1] ?? "");
        store.getInspiration(inspirationId);
        const metadata = parsed(uploadMetadataSchema, {
          role: request.headers.get("x-asset-role") ?? undefined,
          motionTimestampMs:
            request.headers.get("x-motion-timestamp-ms") ?? undefined,
        });
        const bytes = await readBoundedRequestBody(request, UPLOAD_LIMIT);
        const upload = await extractSingleFileMultipart({
          bytes,
          contentType: request.headers.get("content-type") ?? "",
        });
        const stored = await storeContentAddressedUpload({
          assetRoot: config.assetRoot,
          ...upload,
        });
        response = json(
          store.addInspirationAsset(inspirationId, {
            contentHash: stored.sha256,
            relativePath: stored.relativePath,
            mimeType: stored.mimeType,
            role: metadata.role,
            motionTimestampMs: metadata.motionTimestampMs,
          }),
          201,
        );
      } else if (
        url.pathname === "/api/categories" &&
        request.method === "GET"
      ) {
        const query = queryObject(url);
        if (Object.keys(query).some((key) => key !== "includeRetired")) {
          throw new ApiInputError("invalid_query", "Category query is invalid");
        }
        if (
          "includeRetired" in query &&
          query.includeRetired !== "true" &&
          query.includeRetired !== "false"
        ) {
          throw new ApiInputError(
            "invalid_query",
            "includeRetired must be true or false",
          );
        }
        response = json(
          store.listCategories({
            includeRetired: query.includeRetired === "true",
          }),
        );
      } else if (
        url.pathname === "/api/categories" &&
        request.method === "POST"
      ) {
        response = json(store.createCategory(await parseJson(request)), 201);
      } else if (category && request.method === "PATCH") {
        response = json(
          store.updateCategory(
            decodeIdentifier(category[1] ?? ""),
            await parseJson(request),
          ),
        );
      } else if (url.pathname === "/api/briefs" && request.method === "GET") {
        if (url.search.length > 0)
          throw new ApiInputError(
            "invalid_query",
            "Brief listing does not accept query parameters",
          );
        response = json(store.listBriefs());
      } else if (url.pathname === "/api/briefs" && request.method === "POST") {
        response = json(store.createBrief(await parseJson(request)), 201);
      } else if (brief && request.method === "GET") {
        response = json(store.getBrief(decodeIdentifier(brief[1] ?? "")));
      } else if (brief && request.method === "PATCH") {
        response = json(
          store.updateBrief(
            decodeIdentifier(brief[1] ?? ""),
            await parseJson(request),
          ),
        );
      } else if (url.pathname === "/api/projects" && request.method === "GET") {
        if (!projectStore)
          return unavailable(
            "studio_unavailable",
            "Studio project storage is not configured",
          );
        response = json(projectStore.listProjects());
      } else if (
        url.pathname === "/api/projects" &&
        request.method === "POST"
      ) {
        if (!projectStore)
          return unavailable(
            "studio_unavailable",
            "Studio project storage is not configured",
          );
        response = json(
          projectStore.createProject(await parseJson(request)),
          201,
        );
      } else if (project && request.method === "GET") {
        if (!projectStore)
          return unavailable(
            "studio_unavailable",
            "Studio project storage is not configured",
          );
        response = json(
          projectStore.getProject(decodeIdentifier(project[1] ?? "")),
        );
      } else if (project && request.method === "PATCH") {
        if (!projectStore)
          return unavailable(
            "studio_unavailable",
            "Studio project storage is not configured",
          );
        response = json(
          projectStore.updateProject(
            decodeIdentifier(project[1] ?? ""),
            await parseJson(request),
          ),
        );
      } else if (projectBaselines && request.method === "POST") {
        if (!projectStore)
          return unavailable(
            "studio_unavailable",
            "Studio project storage is not configured",
          );
        response = json(
          projectStore.createBaseline(
            decodeIdentifier(projectBaselines[1] ?? ""),
            await parseJson(request),
          ),
          201,
        );
      } else if (projectHandoff && request.method === "GET") {
        // Read-only by construction: the packet summarizes decisions and
        // states what it has deliberately not done. Applying any of it to
        // canonical source or production is separately authorized.
        const packet = buildHandoffPacket({
          database: config.database,
          generatedVariantsRoot: config.generatedVariantsRoot,
          projectId: decodeIdentifier(projectHandoff[1] ?? ""),
          generatedAt: new Date().toISOString(),
        });
        response =
          url.searchParams.get("format") === "markdown"
            ? new Response(renderHandoffMarkdown(packet), {
                headers: { "content-type": "text/markdown; charset=utf-8" },
              })
            : json(packet);
      } else if (projectRounds && request.method === "GET") {
        if (!studio)
          return unavailable("studio_unavailable", "Studio is not configured");
        response = json(
          studio.listRounds(decodeIdentifier(projectRounds[1] ?? "")),
        );
      } else if (projectRounds && request.method === "POST") {
        if (!studio)
          return unavailable("studio_unavailable", "Studio is not configured");
        response = json(
          studio.createRound(
            decodeIdentifier(projectRounds[1] ?? ""),
            await parseJson(request),
          ),
          201,
        );
      } else if (projectRoundDirections && request.method === "PATCH") {
        if (!studio)
          return unavailable("studio_unavailable", "Studio is not configured");
        studio.configureDirections(
          decodeIdentifier(projectRoundDirections[1] ?? ""),
          decodeIdentifier(projectRoundDirections[2] ?? ""),
          await parseJson(request),
        );
        response = json({ ok: true });
      } else if (projectSessions && request.method === "POST") {
        if (!studio)
          return unavailable("studio_unavailable", "Studio is not configured");
        response = json(
          studio.createSession(
            decodeIdentifier(projectSessions[1] ?? ""),
            await parseJson(request),
          ),
          201,
        );
      } else if (session && request.method === "GET") {
        if (!studio)
          return unavailable("studio_unavailable", "Studio is not configured");
        response = json(studio.getSession(decodeIdentifier(session[1] ?? "")));
      } else if (sessionMessages && request.method === "POST") {
        if (
          !studio ||
          !projectStore ||
          !config.projectStorage ||
          !config.agentRunner
        )
          return unavailable(
            "agent_unavailable",
            "Local agent execution is not configured",
          );
        const sessionId = decodeIdentifier(sessionMessages[1] ?? "");
        const body = parsed(agentMessageSchema, await parseJson(request));
        const sessionState = studio.getSession(sessionId);
        const projectState = projectStore.getProject(sessionState.projectId);
        const baseline = projectState.baselines.at(-1);
        if (!baseline)
          throw new StudioError(
            "STUDIO_DATA_INVALID",
            "Project has no baseline",
          );
        const context = buildAgentContext({
          projectTitle: projectState.title,
          projectSource: projectState.canonicalSourcePath,
          baselinePath: baseline.snapshotPath,
          phase: body.phase,
          brief: body.brief,
          round: body.round,
          references: body.references,
          tweaks: body.tweaks,
        });
        const prompt = `${context}\n# Operator message\n\n${body.message}\n`;
        const resume = studio.hasCompletedRun(sessionId);
        const started = studio.startRun(sessionId, body.message);
        try {
          const result = await config.agentRunner.run({
            sessionId,
            prompt,
            cwd: resolve(
              config.projectStorage.runtimeRoot,
              projectState.runtimePath,
            ),
            resume,
            mode: body.mode,
          });
          response = json(
            studio.finishRun(sessionId, started.runId, { text: result.text }),
          );
        } catch (error) {
          studio.finishRun(sessionId, started.runId, {
            error:
              error instanceof Error ? error.message : "Local agent run failed",
            cancelled:
              error instanceof LocalAgentError &&
              error.code === "AGENT_CANCELLED",
          });
          throw error;
        }
      } else if (comparisonJobs && request.method === "GET") {
        response = json(
          jobStore.listForComparison(decodeIdentifier(comparisonJobs[1] ?? "")),
        );
      } else if (comparisonJobs && request.method === "POST") {
        // Enqueue every missing proof for the round. This replaces the old
        // one-long-HTTP-request-per-artifact path: the operator gets job rows
        // immediately and watches them progress.
        if (!studio || !projectStore || !queue)
          return unavailable(
            "agent_unavailable",
            "Local generation is not configured",
          );
        const comparisonId = decodeIdentifier(comparisonJobs[1] ?? "");
        const state = getComparison(config.database, comparisonId);
        const round = config.database
          .query<{ id: string; project_id: string }, [string]>(
            `SELECT id, project_id FROM exploration_rounds
             WHERE comparison_id = ? ORDER BY sequence DESC LIMIT 1`,
          )
          .get(comparisonId);
        if (!round)
          throw new GenerationError(
            "GENERATION_NOT_FOUND",
            "Comparison is not linked to a Studio round",
          );

        const enqueued = [];
        for (const direction of state.directions) {
          for (const engine of ["impeccable", "taste"] as const) {
            // Never regenerate over an existing proof; a registered artifact is
            // immutable exploration evidence.
            if (direction.variants.some((v) => v.engine === engine)) continue;
            try {
              enqueued.push(
                jobStore.enqueue({
                  projectId: round.project_id,
                  roundId: round.id,
                  comparisonId,
                  directionId: direction.id,
                  kind: "wide-net",
                  engine,
                  position: direction.position,
                  idempotencyKey: `wide-net:${comparisonId}:${direction.id}:${engine}`,
                }),
              );
            } catch (error) {
              // An already-active job for this cell is not an error for a
              // "generate everything missing" request.
              if (!(
                error instanceof GenerationJobError &&
                error.code === "JOB_CONFLICT"
              )) {
                throw error;
              }
            }
          }
        }
        queue.wake();
        response = json(
          { enqueued, jobs: jobStore.listForComparison(comparisonId) },
          202,
        );
      } else if (variantTweaks && request.method === "GET") {
        response = json(
          tweakStore.listForVariant(decodeIdentifier(variantTweaks[1] ?? "")),
        );
      } else if (variantTweaks && request.method === "POST") {
        const body = parsed(
          z
            .object({
              label: z.string().trim().max(200).default(""),
              decisions: z.record(z.string(), z.json()),
              idempotencyKey: identifier.optional(),
            })
            .strict(),
          await parseJson(request),
        );
        response = json(
          tweakStore.save({
            variantId: decodeIdentifier(variantTweaks[1] ?? ""),
            label: body.label,
            decisions: body.decisions,
            idempotencyKey: body.idempotencyKey ?? crypto.randomUUID(),
          }),
          201,
        );
      } else if (variantRevisions && request.method === "GET") {
        response = json(
          listRevisions(
            config.database,
            decodeIdentifier(variantRevisions[1] ?? ""),
          ),
        );
      } else if (tweakDecision && request.method === "GET") {
        // Restoring re-validates against the manifest as it is now, so a
        // snapshot taken before a regeneration reports rather than misapplies.
        response = json(
          tweakStore.restore(decodeIdentifier(tweakDecision[1] ?? "")),
        );
      } else if (tweakApply && request.method === "POST") {
        if (!studio || !agentRunner)
          return unavailable(
            "agent_unavailable",
            "Local agent execution is not configured",
          );
        response = json(
          await applyTweakRevision({
            database: config.database,
            studio,
            runner: agentRunner,
            generatedVariantsRoot: config.generatedVariantsRoot,
            workbenchRoot: resolve(config.workbenchRoot),
            decisionSet: tweakStore.get(decodeIdentifier(tweakApply[1] ?? "")),
            model: config.generation.model,
            effort: config.generation.effort,
          }),
          201,
        );
      } else if (roundJobs && request.method === "GET") {
        response = json(
          jobStore.listForRound(decodeIdentifier(roundJobs[1] ?? "")),
        );
      } else if (roundGenerate && request.method === "POST") {
        // Enqueue the three refinement options for a refinement round. Each
        // option branches from the chosen proof under its own lens.
        if (!studio || !queue)
          return unavailable(
            "agent_unavailable",
            "Local generation is not configured",
          );
        const roundId = decodeIdentifier(roundGenerate[1] ?? "");
        const body = parsed(
          z
            .object({
              engine: z.enum(["impeccable", "taste"]).optional(),
            })
            .strict(),
          await parseJson(request),
        );
        // Resolving the parent first fails fast with a clear reason when the
        // direction has no proof to refine.
        const target = resolveRefinementParent(
          config.database,
          roundId,
          body.engine,
        );
        const round = config.database
          .query<{ project_id: string }, [string]>(
            "SELECT project_id FROM exploration_rounds WHERE id = ?",
          )
          .get(roundId);
        if (!round)
          throw new GenerationError(
            "GENERATION_NOT_FOUND",
            "Refinement round does not exist",
          );

        const enqueued = [];
        for (const [position, lens] of REFINEMENT_LENSES.entries()) {
          try {
            enqueued.push(
              jobStore.enqueue({
                projectId: round.project_id,
                roundId,
                comparisonId: target.comparisonId,
                directionId: target.directionId,
                kind: "refinement",
                engine: target.engine,
                position,
                payload: {
                  lens: lens.slug,
                  artifactPath: refinementArtifactPath(target, lens),
                },
                idempotencyKey: `refinement:${roundId}:${lens.slug}`,
              }),
            );
          } catch (error) {
            if (!(
              error instanceof GenerationJobError &&
              error.code === "JOB_CONFLICT"
            )) {
              throw error;
            }
          }
        }
        queue.wake();
        response = json(
          { enqueued, jobs: jobStore.listForRound(roundId) },
          202,
        );
      } else if (job && request.method === "GET") {
        response = json(jobStore.get(decodeIdentifier(job[1] ?? "")));
      } else if (jobCancel && request.method === "POST") {
        response = json(
          jobStore.requestCancel(decodeIdentifier(jobCancel[1] ?? "")),
        );
      } else if (comparisonGeneration && request.method === "POST") {
        if (
          !studio ||
          !projectStore ||
          !config.projectStorage ||
          !config.agentRunner
        )
          return unavailable(
            "agent_unavailable",
            "Local generation is not configured",
          );
        response = json(
          await generateComparisonVariant({
            database: config.database,
            projects: projectStore,
            studio,
            runner: config.agentRunner,
            projectRuntimeRoot: config.projectStorage.runtimeRoot,
            generatedVariantsRoot: config.generatedVariantsRoot,
            workbenchRoot: resolve(config.workbenchRoot),
            comparisonId: decodeIdentifier(comparisonGeneration[1] ?? ""),
            directionId: decodeIdentifier(comparisonGeneration[2] ?? ""),
            engine: parsed(
              z.enum(["impeccable", "taste"]),
              comparisonGeneration[3],
            ),
            model: config.generation.model,
            effort: config.generation.effort,
          }),
          201,
        );
      } else if (comparisonRefinement && request.method === "POST") {
        if (!studio)
          return unavailable("studio_unavailable", "Studio is not configured");
        const body = parsed(
          z.object({ idempotencyKey: identifier }).strict(),
          await parseJson(request),
        );
        response = json(
          studio.createRefinement({
            comparisonId: decodeIdentifier(comparisonRefinement[1] ?? ""),
            directionId: decodeIdentifier(comparisonRefinement[2] ?? ""),
            idempotencyKey: body.idempotencyKey,
          }),
          201,
        );
      } else if (
        url.pathname === "/api/comparisons" &&
        request.method === "GET"
      ) {
        response = json(listComparisons(config.database));
      } else if (
        url.pathname === "/api/comparisons" &&
        request.method === "POST"
      ) {
        const body = parsed(comparisonCreateSchema, await parseJson(request));
        const savedBrief = store.getBrief(body.brief);
        const created = createComparison(config.database, {
          brief: savedBrief.id,
          directions: body.directions,
          generatedRoot: config.generatedVariantsRoot,
        });
        response = json(
          getComparison(config.database, created.comparisonId),
          201,
        );
      } else if (comparison && request.method === "GET") {
        response = json(
          getComparison(config.database, decodeIdentifier(comparison[1] ?? "")),
        );
      } else if (comparison && request.method === "PATCH") {
        response = json(
          updateComparison(
            config.database,
            decodeIdentifier(comparison[1] ?? ""),
            await parseJson(request),
          ),
        );
      } else if (
        url.pathname === "/api/variants/register" &&
        request.method === "POST"
      ) {
        const body = parsed(variantInputSchema, await parseJson(request));
        response = json(
          registerVariant(config.database, {
            ...body,
            generatedRoot: config.generatedVariantsRoot,
          }),
          201,
        );
      } else {
        response = failure(404, "not_found", "API route not found");
      }
      return withCors(response, requestOrigin);
    } catch (error) {
      return withCors(responseForError(error), requestOrigin);
    }
  };
}

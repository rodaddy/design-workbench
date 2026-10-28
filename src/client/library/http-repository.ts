import { z } from "zod";

import { parseDesignBrief } from "../../shared/brief";
import {
  LibraryRepositoryError,
  type BriefImport,
  type CaptureStatus,
  type Category,
  type Confidence,
  type DesignBrief,
  type Inspiration,
  type InspirationDraft,
  type LibraryRepository,
  type LibrarySnapshot,
} from "./types";

const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().trim().min(1),
        message: z.string().trim().min(1),
        issues: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();

const categoryDtoSchema = z
  .object({
    id: z.string().trim().min(1),
    slug: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string(),
    inclusionRules: z.string(),
    exclusionRules: z.string(),
    isProvisional: z.boolean(),
    isRetired: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const assetUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      const parsed = new URL(
        value,
        globalThis.location?.origin ?? "http://localhost",
      );
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "Asset URL must be an HTTP(S) URL or same-origin path");

const assetDtoSchema = z
  .object({
    id: z.string().trim().min(1),
    relativePath: z.string().trim().min(1),
    mimeType: z.string().trim().min(1),
    role: z.string().trim().min(1),
    contentHash: z.string().nullable(),
    isAvailable: z.boolean(),
    motionTimestampMs: z.number().int().nonnegative().nullable(),
    url: assetUrlSchema.optional(),
    alt: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strict();

const inspirationDtoSchema = z
  .object({
    id: z.string().trim().min(1),
    sourceUrl: z.string().url(),
    resolvedUrl: z.string().url().nullable(),
    title: z.string().trim().min(1),
    purpose: z.string(),
    aestheticFamily: z.string(),
    visualVocabulary: z.array(z.string().trim().min(1)),
    brief: z.string(),
    captureType: z.string().trim().min(1),
    confidence: z.enum(["high", "medium", "low"]),
    sourceStatus: z.enum(["captured", "partial", "blocked"]),
    provenancePath: z.string(),
    limitation: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    tags: z.array(z.string().trim().min(1)),
    categories: z.array(categoryDtoSchema),
    assets: z.array(assetDtoSchema),
  })
  .strict();

const briefDtoSchema = z
  .object({
    id: z.string().trim().min(1),
    slug: z.string().trim().min(1),
    title: z.string().trim().min(1),
    markdown: z.string().trim().min(1),
    finalPrompt: z.string().trim().min(1),
    sourceInspirationId: z.string().trim().min(1).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const healthSchema = z.object({ ok: z.literal(true) }).strict();

type InspirationDto = z.infer<typeof inspirationDtoSchema>;
type CategoryDto = z.infer<typeof categoryDtoSchema>;
type BriefDto = z.infer<typeof briefDtoSchema>;

function detailsForIssues(issues: unknown): string {
  if (issues === undefined) return "";
  try {
    return ` Issues: ${JSON.stringify(issues)}`;
  } catch {
    return " Issues were returned but could not be serialized.";
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new LibraryRepositoryError(
      "LIBRARY_API_INVALID_JSON",
      `LIBRARY_API_INVALID_JSON: ${response.status} ${response.statusText || "response"} did not contain valid JSON.`,
      { cause },
    );
  }
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers:
        init?.body instanceof FormData
          ? init.headers
          : { "Content-Type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new LibraryRepositoryError(
      "LIBRARY_NETWORK_ERROR",
      `LIBRARY_NETWORK_ERROR: Could not reach ${path}.`,
      { cause },
    );
  }

  const body = await readJson(response);
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    if (!parsed.success) {
      throw new LibraryRepositoryError(
        "LIBRARY_API_INVALID_ERROR_RESPONSE",
        `LIBRARY_API_INVALID_ERROR_RESPONSE: ${path} failed with HTTP ${response.status}, but the error body did not match the API contract.`,
        { cause: parsed.error },
      );
    }
    const { code, message, issues } = parsed.data.error;
    throw new LibraryRepositoryError(
      code,
      `${code}: ${message}${detailsForIssues(issues)}`,
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new LibraryRepositoryError(
      "LIBRARY_API_INVALID_RESPONSE",
      `LIBRARY_API_INVALID_RESPONSE: ${path} returned an unexpected response shape.`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function sourceLabel(sourceUrl: string): string {
  return new URL(sourceUrl).hostname;
}

function categoryFromDto(dto: CategoryDto): Category {
  return {
    id: dto.id,
    name: dto.name,
    provisional: dto.isProvisional,
    retired: dto.isRetired,
  };
}

function inspirationFromDto(dto: InspirationDto): {
  inspiration: Inspiration;
  withheldAssets: number;
} {
  const assets = dto.assets.flatMap((asset) => {
    if (
      !asset.isAvailable ||
      asset.url === undefined ||
      asset.width === undefined ||
      asset.height === undefined
    ) {
      return [];
    }
    return [
      {
        id: asset.id,
        url: asset.url,
        alt: asset.alt?.trim() || `${dto.title} reference`,
        width: asset.width,
        height: asset.height,
        mimeType: asset.mimeType,
      },
    ];
  });

  return {
    inspiration: {
      id: dto.id,
      title: dto.title,
      sourceUrl: dto.sourceUrl,
      source: sourceLabel(dto.sourceUrl),
      purpose: dto.purpose || undefined,
      aestheticFamily: dto.aestheticFamily,
      vocabulary: dto.visualVocabulary,
      tags: dto.tags,
      categoryIds: dto.categories.map((category) => category.id),
      captureType: dto.captureType,
      status: dto.sourceStatus,
      confidence: dto.confidence,
      limitation: dto.limitation ?? "",
      brief: dto.brief,
      assets,
      createdAt: dto.createdAt,
      updatedAt: dto.updatedAt,
    },
    withheldAssets: dto.assets.length - assets.length,
  };
}

function briefFromDto(dto: BriefDto): DesignBrief {
  return {
    id: dto.id,
    title: dto.title,
    markdown: dto.markdown,
    finalPrompt: dto.finalPrompt,
    createdAt: dto.createdAt,
    ...(dto.sourceInspirationId === null
      ? {}
      : { sourceInspirationId: dto.sourceInspirationId }),
  };
}

function confidenceFromStatus(status: CaptureStatus): Confidence {
  if (status === "captured") return "high";
  if (status === "partial") return "medium";
  return "low";
}

function editableInspirationPayload(
  input: InspirationDraft,
): Record<string, unknown> {
  return {
    sourceUrl: input.sourceUrl,
    title: input.title,
    aestheticFamily: input.aestheticFamily,
    visualVocabulary: [...input.vocabulary],
    tags: [...input.tags],
    categoryIds: [...input.categoryIds],
    sourceStatus: input.status,
    limitation: input.limitation || null,
    brief: input.brief,
  };
}

function createInspirationPayload(
  input: InspirationDraft,
): Record<string, unknown> {
  return {
    ...editableInspirationPayload(input),
    confidence: confidenceFromStatus(input.status),
    captureType: input.screenshot ? "image" : "url",
  };
}

async function uploadScreenshot(
  id: string,
  file: File,
): Promise<InspirationDto> {
  const form = new FormData();
  form.append("file", file, file.name);
  return request(
    `/api/inspirations/${encodeURIComponent(id)}/assets`,
    inspirationDtoSchema,
    { method: "POST", body: form },
  );
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function slugFromTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `brief-${stableHash(title)}`;
}

export class HttpLibraryRepository implements LibraryRepository {
  async load(): Promise<LibrarySnapshot> {
    const [health, inspirationDtos, categoryDtos, briefDtos] =
      await Promise.all([
        request("/api/health", healthSchema),
        request("/api/inspirations", z.array(inspirationDtoSchema)),
        request(
          "/api/categories?includeRetired=true",
          z.array(categoryDtoSchema),
        ),
        request("/api/briefs", z.array(briefDtoSchema)),
      ]);
    const mapped = inspirationDtos.map(inspirationFromDto);
    const inspirations = mapped.map(({ inspiration }) => inspiration);
    const withheldAssets = mapped.reduce(
      (sum, entry) => sum + entry.withheldAssets,
      0,
    );

    return {
      inspirations,
      categories: categoryDtos.map(categoryFromDto),
      briefs: briefDtos.map(briefFromDto),
      captureTypes: [
        ...new Set(inspirations.map((item) => item.captureType)),
      ].sort(),
      sources: [...new Set(inspirations.map((item) => item.source))].sort(),
      tags: [...new Set(inspirations.flatMap((item) => item.tags))].sort(),
      systemStatus: withheldAssets > 0 ? "degraded" : "ready",
      statusMessage:
        withheldAssets > 0
          ? `Library connected; ${withheldAssets} local evidence asset${withheldAssets === 1 ? " is" : "s are"} withheld pending validated URL and dimensions.`
          : health.ok
            ? "Library connected."
            : "Library health is unavailable.",
    };
  }

  async createInspiration(input: InspirationDraft): Promise<Inspiration> {
    let dto = await request("/api/inspirations", inspirationDtoSchema, {
      method: "POST",
      body: JSON.stringify(createInspirationPayload(input)),
    });
    if (input.screenshot) {
      try {
        dto = await uploadScreenshot(dto.id, input.screenshot);
      } catch (cause) {
        throw new LibraryRepositoryError(
          "INSPIRATION_ASSET_UPLOAD_PARTIAL",
          "INSPIRATION_ASSET_UPLOAD_PARTIAL: The reference was created, but its screenshot upload failed. Reload and edit the saved reference to retry.",
          { cause },
        );
      }
    }
    return inspirationFromDto(dto).inspiration;
  }

  async updateInspiration(
    id: string,
    input: InspirationDraft,
  ): Promise<Inspiration> {
    let dto = await request(
      `/api/inspirations/${encodeURIComponent(id)}`,
      inspirationDtoSchema,
      {
        method: "PATCH",
        body: JSON.stringify(editableInspirationPayload(input)),
      },
    );
    if (input.screenshot) {
      try {
        dto = await uploadScreenshot(dto.id, input.screenshot);
      } catch (cause) {
        throw new LibraryRepositoryError(
          "INSPIRATION_ASSET_UPLOAD_PARTIAL",
          "INSPIRATION_ASSET_UPLOAD_PARTIAL: The reference changes were saved, but its screenshot upload failed. Reload and edit the saved reference to retry.",
          { cause },
        );
      }
    }
    return inspirationFromDto(dto).inspiration;
  }

  async renameCategory(id: string, name: string): Promise<Category> {
    const dto = await request(
      `/api/categories/${encodeURIComponent(id)}`,
      categoryDtoSchema,
      { method: "PATCH", body: JSON.stringify({ name }) },
    );
    return categoryFromDto(dto);
  }

  async retireCategory(id: string): Promise<Category> {
    const dto = await request(
      `/api/categories/${encodeURIComponent(id)}`,
      categoryDtoSchema,
      { method: "PATCH", body: JSON.stringify({ isRetired: true }) },
    );
    return categoryFromDto(dto);
  }

  async importBrief(input: BriefImport): Promise<DesignBrief> {
    const parsed = parseDesignBrief(input.markdown);
    const dto = await request("/api/briefs", briefDtoSchema, {
      method: "POST",
      body: JSON.stringify({
        slug: slugFromTitle(parsed.title),
        markdown: input.markdown,
        sourceInspirationId: input.sourceInspirationId ?? null,
      }),
    });
    return briefFromDto(dto);
  }

  async createBriefFromInspiration(id: string): Promise<DesignBrief> {
    const dto = await request(
      `/api/inspirations/${encodeURIComponent(id)}/brief`,
      briefDtoSchema,
      { method: "POST" },
    );
    return briefFromDto(dto);
  }
}

export const httpLibraryRepository = new HttpLibraryRepository();

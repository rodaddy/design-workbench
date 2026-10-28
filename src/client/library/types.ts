export const captureStatuses = ["captured", "partial", "blocked"] as const;
export type CaptureStatus = (typeof captureStatuses)[number];
export const confidenceLevels = ["high", "medium", "low"] as const;
export type Confidence = (typeof confidenceLevels)[number];

export interface InspirationAsset {
  readonly id: string;
  readonly url: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  readonly mimeType: string;
}

export interface Inspiration {
  readonly id: string;
  readonly title: string;
  readonly sourceUrl: string;
  readonly source: string;
  readonly purpose?: string;
  readonly aestheticFamily: string;
  readonly vocabulary: readonly string[];
  readonly tags: readonly string[];
  readonly categoryIds: readonly string[];
  readonly captureType: string;
  readonly status: CaptureStatus;
  readonly confidence: Confidence;
  readonly composition?: string;
  readonly typography?: string;
  readonly colorMaterial?: string;
  readonly motion?: string;
  readonly borrow?: string;
  readonly avoid?: string;
  readonly limitation: string;
  readonly brief: string;
  readonly prompt?: string;
  readonly assets: readonly InspirationAsset[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Category {
  readonly id: string;
  readonly name: string;
  readonly provisional: boolean;
  readonly retired: boolean;
}

export interface DesignBrief {
  readonly id: string;
  readonly title: string;
  readonly markdown: string;
  readonly finalPrompt: string;
  readonly createdAt: string;
  readonly sourceInspirationId?: string;
}

export interface LibrarySnapshot {
  readonly inspirations: readonly Inspiration[];
  readonly categories: readonly Category[];
  readonly briefs: readonly DesignBrief[];
  readonly captureTypes: readonly string[];
  readonly sources: readonly string[];
  readonly tags: readonly string[];
  readonly systemStatus: "ready" | "degraded";
  readonly statusMessage: string;
}

export interface InspirationDraft {
  readonly sourceUrl: string;
  readonly screenshot?: File;
  readonly title: string;
  readonly aestheticFamily: string;
  readonly vocabulary: readonly string[];
  readonly tags: readonly string[];
  readonly categoryIds: readonly string[];
  readonly status: CaptureStatus;
  readonly limitation: string;
  readonly brief: string;
}

export interface BriefImport {
  readonly markdown: string;
  readonly sourceInspirationId?: string;
}

export interface LibraryRepository {
  load(): Promise<LibrarySnapshot>;
  createInspiration(input: InspirationDraft): Promise<Inspiration>;
  updateInspiration(id: string, input: InspirationDraft): Promise<Inspiration>;
  renameCategory(id: string, name: string): Promise<Category>;
  retireCategory(id: string): Promise<Category>;
  importBrief(input: BriefImport): Promise<DesignBrief>;
  createBriefFromInspiration(id: string): Promise<DesignBrief>;
}

export const API_CONTRACT_UNAVAILABLE =
  "LIBRARY_API_CONTRACT_UNAVAILABLE: No LibraryRepository has been configured.";

export class LibraryRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LibraryRepositoryError";
  }
}

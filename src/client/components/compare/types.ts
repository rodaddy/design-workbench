import { z } from "zod";

export const comparisonEngineSchema = z.enum(["impeccable", "taste"]);
export type ComparisonEngine = z.infer<typeof comparisonEngineSchema>;

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const comparisonVariantSchema = z.object({
  id: z.string().min(1),
  engine: comparisonEngineSchema,
  artifactPath: z.string().min(1),
  viewport: jsonObjectSchema,
  metadata: jsonObjectSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const comparisonDirectionSchema = z.object({
  id: z.string().min(1),
  position: z.number().int().min(0).max(4),
  slug: z.string().min(1),
  title: z.string().min(1),
  metadata: jsonObjectSchema,
  createdAt: z.string().min(1),
  variants: z.array(comparisonVariantSchema).max(2),
});

export const comparisonSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  sourceBriefId: z.string().nullable(),
  status: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  directions: z.array(comparisonDirectionSchema).min(1).max(5),
});

export const comparisonListSchema = z.array(comparisonSchema);

export type ComparisonVariant = z.infer<typeof comparisonVariantSchema>;
export type ComparisonDirection = z.infer<typeof comparisonDirectionSchema>;
export type Comparison = z.infer<typeof comparisonSchema>;

export interface CreateComparisonInput {
  readonly brief: string;
  readonly directions: number;
}

export interface ComparisonRepository {
  list(): Promise<readonly Comparison[]>;
  get(identifier: string): Promise<Comparison>;
  create(input: CreateComparisonInput): Promise<Comparison>;
}

export class ComparisonRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ComparisonRepositoryError";
  }
}

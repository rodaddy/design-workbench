import { z } from "zod";
import {
  comparisonListSchema,
  comparisonSchema,
  ComparisonRepositoryError,
  type ComparisonRepository,
  type CreateComparisonInput,
} from "./types";

interface HttpComparisonRepositoryOptions {
  readonly apiOrigin: string;
  readonly fetchImpl?: FetchLike;
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function validatedApiOrigin(value: string): string {
  const parsed = z.string().url().parse(value);
  const url = new URL(parsed);
  if (url.origin !== parsed.replace(/\/$/, "")) {
    throw new ComparisonRepositoryError(
      "COMPARE_API_ORIGIN_INVALID",
      "Comparison API origin must contain only scheme, host, and optional port.",
    );
  }
  return url.origin;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new ComparisonRepositoryError(
      "COMPARE_API_RESPONSE_INVALID",
      "Comparison API returned a non-JSON response.",
      { cause: error },
    );
  }
}

async function request(
  fetchImpl: FetchLike,
  url: URL,
  init?: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new ComparisonRepositoryError(
      "COMPARE_API_UNAVAILABLE",
      "Comparison API is unavailable. Start the trusted app server and retry.",
      { cause: error },
    );
  }

  const body = await responseJson(response);
  if (!response.ok) {
    const parsed = z
      .object({
        error: z.object({
          code: z.string().optional(),
          message: z.string().optional(),
        }),
      })
      .safeParse(body);
    throw new ComparisonRepositoryError(
      parsed.success
        ? (parsed.data.error.code ?? "COMPARE_API_FAILED")
        : "COMPARE_API_FAILED",
      parsed.success
        ? (parsed.data.error.message ??
            `Comparison API failed with status ${response.status}.`)
        : `Comparison API failed with status ${response.status}.`,
    );
  }
  return body;
}

function contractError(error: z.ZodError): ComparisonRepositoryError {
  return new ComparisonRepositoryError(
    "COMPARE_API_CONTRACT_INVALID",
    "Comparison API returned data that does not match the client contract.",
    { cause: error },
  );
}

export function createHttpComparisonRepository({
  apiOrigin,
  fetchImpl = fetch,
}: HttpComparisonRepositoryOptions): ComparisonRepository {
  const origin = validatedApiOrigin(apiOrigin);

  return {
    async list() {
      const parsed = comparisonListSchema.safeParse(
        await request(fetchImpl, new URL("/api/comparisons", origin)),
      );
      if (!parsed.success) throw contractError(parsed.error);
      return parsed.data;
    },

    async get(identifier: string) {
      const parsedIdentifier = z
        .string()
        .trim()
        .min(1)
        .max(200)
        .safeParse(identifier);
      if (!parsedIdentifier.success) {
        throw new ComparisonRepositoryError(
          "COMPARE_IDENTIFIER_INVALID",
          "Comparison identifier is invalid.",
          { cause: parsedIdentifier.error },
        );
      }
      const parsed = comparisonSchema.safeParse(
        await request(
          fetchImpl,
          new URL(
            `/api/comparisons/${encodeURIComponent(parsedIdentifier.data)}`,
            origin,
          ),
        ),
      );
      if (!parsed.success) throw contractError(parsed.error);
      return parsed.data;
    },

    async create(input: CreateComparisonInput) {
      const parsedInput = z
        .object({
          brief: z.string().trim().min(1),
          directions: z.number().int().min(1).max(5),
        })
        .strict()
        .safeParse(input);
      if (!parsedInput.success) {
        throw new ComparisonRepositoryError(
          "COMPARE_CREATE_INPUT_INVALID",
          "Choose a source and one to five directions.",
          { cause: parsedInput.error },
        );
      }
      const parsed = comparisonSchema.safeParse(
        await request(fetchImpl, new URL("/api/comparisons", origin), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsedInput.data),
        }),
      );
      if (!parsed.success) throw contractError(parsed.error);
      return parsed.data;
    },
  };
}

export function comparisonMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "COMPARE_OPERATION_FAILED: The comparison operation failed without an error message.";
}

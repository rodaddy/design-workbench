import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { ComparisonError, createComparison } from "../src/server/comparisons";
import { openDatabase } from "../src/server/database";
import { DesignBriefValidationError } from "../src/shared/brief";

const REPO_ROOT = resolve(import.meta.dir, "..");
export const COMPARISON_NEW_USAGE = `Usage:
  bun run comparison:new --brief <path-or-id> --directions <1-5> [--db <path>] [--generated-root <path>]

Creates one persisted comparison packet and empty Impeccable/Taste artifact directories.
It does not invoke a model, read model credentials, or launch a browser job.`;

const cliSchema = z
  .object({
    brief: z.string().trim().min(1),
    directions: z.coerce.number().int().min(1).max(5),
    db: z
      .string()
      .trim()
      .min(1)
      .default(resolve(REPO_ROOT, "data/design-workbench.sqlite")),
    generatedRoot: z
      .string()
      .trim()
      .min(1)
      .default(resolve(REPO_ROOT, "generated-variants")),
  })
  .strict();

type JsonError = {
  error: {
    code: string;
    message: string;
    issues?: unknown;
  };
};

function parseArguments(args: readonly string[]): unknown {
  const values: Record<string, string> = {};
  const names: Record<string, string> = {
    "--brief": "brief",
    "--directions": "directions",
    "--db": "db",
    "--generated-root": "generatedRoot",
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const name = names[flag ?? ""];
    const value = args[index + 1];
    if (!name || !value || value.startsWith("--")) {
      throw new ComparisonError(
        "INVALID_CLI_ARGUMENTS",
        `Invalid or incomplete argument '${flag ?? ""}'`,
      );
    }
    if (name in values) {
      throw new ComparisonError(
        "INVALID_CLI_ARGUMENTS",
        `Duplicate argument '${flag}'`,
      );
    }
    values[name] = value;
    index += 1;
  }
  return values;
}

function jsonError(error: unknown): JsonError {
  if (error instanceof DesignBriefValidationError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        issues: error.issues,
      },
    };
  }
  if (error instanceof ComparisonError) {
    const cause = error.cause;
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(cause instanceof z.ZodError ? { issues: cause.issues } : {}),
      },
    };
  }
  if (error instanceof z.ZodError) {
    return {
      error: {
        code: "INVALID_CLI_ARGUMENTS",
        message: "CLI arguments are invalid",
        issues: error.issues,
      },
    };
  }
  return {
    error: {
      code: "COMPARISON_NEW_FAILED",
      message: "Comparison creation failed",
    },
  };
}

export function runComparisonNew(args: readonly string[]): number {
  if (args.length === 1 && args[0] === "--help") {
    console.log(COMPARISON_NEW_USAGE);
    return 0;
  }
  let database: ReturnType<typeof openDatabase> | undefined;
  try {
    const input = cliSchema.parse(parseArguments(args));
    const databasePath = resolve(input.db);
    mkdirSync(dirname(databasePath), { recursive: true });
    database = openDatabase(databasePath);
    const result = createComparison(database, {
      brief: input.brief,
      directions: input.directions,
      generatedRoot: resolve(input.generatedRoot),
    });
    const operatorPackets = result.directions.flatMap((direction) =>
      (["impeccable", "taste"] as const).map((engine) => ({
        direction: direction.slug,
        engine,
        operator: engine === "impeccable" ? "Impeccable" : "Taste Skill",
        outputDirectory: resolve(result.directory, direction.slug, engine),
      })),
    );
    console.log(
      JSON.stringify({ ok: true, comparison: result, operatorPackets }),
    );
    return 0;
  } catch (error) {
    console.error(JSON.stringify(jsonError(error)));
    return 1;
  } finally {
    database?.close(false);
  }
}

if (import.meta.main) {
  process.exitCode = runComparisonNew(Bun.argv.slice(2));
}

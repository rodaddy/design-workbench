import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { openDatabase } from "../src/server/database";
import {
  registerVariant,
  VariantRegistrationError,
} from "../src/server/variants";

const REPO_ROOT = resolve(import.meta.dir, "..");
export const VARIANT_REGISTER_USAGE = `Usage:
  bun run variant:register --comparison <id-or-slug> --direction <id-or-slug> --engine <impeccable|taste> --path <directory> [--db <path>] [--generated-root <path>] [--viewport <json>] [--metadata <json>]

Validates and registers an existing static artifact containing index.html.
It does not invoke a model, read model credentials, or launch a browser job.`;
const cliSchema = z
  .object({
    comparison: z.string().trim().min(1),
    direction: z.string().trim().min(1),
    engine: z.enum(["impeccable", "taste"]),
    path: z.string().trim().min(1),
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
    viewport: z.record(z.string(), z.json()).default({}),
    metadata: z.record(z.string(), z.json()).default({}),
  })
  .strict();

function parseJsonObject(value: string, flag: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("Expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new VariantRegistrationError(
      "INVALID_CLI_ARGUMENTS",
      `${flag} must be a valid JSON object`,
      { cause: error },
    );
  }
}

function parseArguments(args: readonly string[]): unknown {
  const values: Record<string, unknown> = {};
  const names: Record<string, string> = {
    "--comparison": "comparison",
    "--direction": "direction",
    "--engine": "engine",
    "--path": "path",
    "--db": "db",
    "--generated-root": "generatedRoot",
    "--viewport": "viewport",
    "--metadata": "metadata",
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? "";
    const name = names[flag];
    const value = args[index + 1];
    if (!name || !value || value.startsWith("--") || name in values) {
      throw new VariantRegistrationError(
        "INVALID_CLI_ARGUMENTS",
        `Invalid, duplicate, or incomplete argument '${flag}'`,
      );
    }
    values[name] =
      name === "viewport" || name === "metadata"
        ? parseJsonObject(value, flag)
        : value;
    index += 1;
  }
  return values;
}

function jsonError(error: unknown): {
  error: { code: string; message: string; issues?: unknown };
} {
  if (error instanceof VariantRegistrationError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.cause instanceof z.ZodError
          ? { issues: error.cause.issues }
          : {}),
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
      code: "VARIANT_REGISTER_FAILED",
      message: "Variant registration failed",
    },
  };
}

export function runVariantRegister(args: readonly string[]): number {
  if (args.length === 1 && args[0] === "--help") {
    console.log(VARIANT_REGISTER_USAGE);
    return 0;
  }
  let database: ReturnType<typeof openDatabase> | undefined;
  try {
    const input = cliSchema.parse(parseArguments(args));
    const { db, ...registrationInput } = input;
    const databasePath = resolve(db);
    mkdirSync(dirname(databasePath), { recursive: true });
    database = openDatabase(databasePath);
    const variant = registerVariant(database, {
      ...registrationInput,
      path: resolve(registrationInput.path),
      generatedRoot: resolve(registrationInput.generatedRoot),
    });
    console.log(JSON.stringify({ ok: true, variant }));
    return 0;
  } catch (error) {
    console.error(JSON.stringify(jsonError(error)));
    return 1;
  } finally {
    database?.close(false);
  }
}

if (import.meta.main) {
  process.exitCode = runVariantRegister(Bun.argv.slice(2));
}

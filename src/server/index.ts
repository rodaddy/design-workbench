import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { LocalAgentRunner } from "./agent-runner";
import { startAppServer } from "./app-server";
import { openDatabase } from "./database";
import { startVariantServer } from "./variant-server";

const loopback = z.enum(["127.0.0.1", "::1", "localhost"]);
const environmentSchema = z
  .object({
    HOST: loopback.default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    VARIANT_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    DATABASE_PATH: z
      .string()
      .trim()
      .min(1)
      .default("data/design-workbench.sqlite"),
    ASSET_ROOT: z.string().trim().min(1).default("data/assets"),
    CAPTURES_ROOT: z.string().trim().min(1).default("captures"),
    GENERATED_VARIANTS_ROOT: z
      .string()
      .trim()
      .min(1)
      .default("generated-variants"),
    DIST_ROOT: z.string().trim().min(1).default("dist"),
    TRUSTED_ORIGINS: z.string().trim().min(1).optional(),
    PROJECT_SOURCE_ROOTS: z.string().trim().min(1).optional(),
    PROJECT_RUNTIME_ROOT: z.string().trim().min(1).default("data/projects"),
    LOCAL_AGENT_EXECUTABLE: z.string().trim().min(1).default("claude"),
    // Generation model/effort are operator configuration, not a hardcoded
    // constant, so a routing-policy change does not require a code edit.
    GENERATION_MODEL: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .default("claude-opus-5"),
    GENERATION_EFFORT: z.enum(["low", "medium", "high"]).default("high"),
  })
  .passthrough();

export function startServers(
  environment: Record<string, string | undefined> = Bun.env,
) {
  const config = environmentSchema.parse(environment);
  if (config.PORT === config.VARIANT_PORT)
    throw new Error("PORT and VARIANT_PORT must differ");
  const assetRoot = resolve(config.ASSET_ROOT);
  const generatedRoot = resolve(config.GENERATED_VARIANTS_ROOT);
  const projectRuntimeRoot = resolve(config.PROJECT_RUNTIME_ROOT);
  const siblingSiteRoot = resolve("..", "rtech-consulting", "site");
  const projectSourceRoots = config.PROJECT_SOURCE_ROOTS
    ? config.PROJECT_SOURCE_ROOTS.split(",").map((value) =>
        resolve(value.trim()),
      )
    : existsSync(siblingSiteRoot)
      ? [siblingSiteRoot]
      : undefined;
  mkdirSync(resolve(config.DATABASE_PATH, ".."), { recursive: true });
  mkdirSync(assetRoot, { recursive: true });
  mkdirSync(resolve(config.CAPTURES_ROOT), { recursive: true });
  mkdirSync(generatedRoot, { recursive: true });
  if (projectSourceRoots) mkdirSync(projectRuntimeRoot, { recursive: true });
  const agentRunner = projectSourceRoots
    ? new LocalAgentRunner({
        executable: config.LOCAL_AGENT_EXECUTABLE,
        reviewRoots: [projectRuntimeRoot],
        buildRoots: [projectRuntimeRoot, generatedRoot],
      })
    : undefined;
  const database = openDatabase(resolve(config.DATABASE_PATH));
  const trustedOrigin = `http://${config.HOST}:${config.PORT}`;
  const allowedOrigins = config.TRUSTED_ORIGINS
    ? config.TRUSTED_ORIGINS.split(",").map((value) => value.trim())
    : config.NODE_ENV === "production"
      ? [trustedOrigin]
      : [trustedOrigin, "http://127.0.0.1:5173", "http://localhost:5173"];
  let app: ReturnType<typeof startAppServer> | undefined;
  try {
    app = startAppServer({
      api: {
        database,
        assetRoot,
        generatedVariantsRoot: generatedRoot,
        allowedOrigins,
        workbenchRoot: resolve(import.meta.dir, "../.."),
        generation: {
          model: config.GENERATION_MODEL,
          effort: config.GENERATION_EFFORT,
        },
        ...(projectSourceRoots
          ? {
              projectStorage: {
                allowedSourceRoots: projectSourceRoots,
                runtimeRoot: projectRuntimeRoot,
              },
              agentRunner,
            }
          : {}),
      },
      capturesRoot: resolve(config.CAPTURES_ROOT),
      assetRoot,
      distRoot: resolve(config.DIST_ROOT),
      mode: config.NODE_ENV === "production" ? "production" : "development",
      variantOrigin: `http://${config.HOST}:${config.VARIANT_PORT}`,
      hostname: config.HOST,
      port: config.PORT,
    });
    const variant = startVariantServer({
      generatedVariantsRoot: generatedRoot,
      trustedOrigins: allowedOrigins,
      hostname: config.HOST,
      port: config.VARIANT_PORT,
    });
    return { app, variant, database };
  } catch (error) {
    app?.stop(true);
    database.close(false);
    throw error;
  }
}

if (import.meta.main) {
  const running = startServers();
  console.info(`Design Workbench API listening on ${running.app.url}`);
  console.info(`Variant server listening on ${running.variant.url}`);
}

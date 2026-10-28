import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { createApiFetchHandler, type ApiConfig } from "./api";
import {
  createCaptureFetchHandler,
  resolveContainedFile,
  contentTypeForPath,
} from "./static-files";

const originSchema = z
  .string()
  .url()
  .transform((value, context) => {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== value.replace(/\/$/, "")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "variantOrigin must contain only an HTTP(S) scheme, host, and optional port",
      });
      return z.NEVER;
    }
    return url.origin;
  });

const configSchema = z
  .object({
    api: z.custom<ApiConfig>(),
    capturesRoot: z.string().trim().min(1),
    assetRoot: z.string().trim().min(1),
    mode: z.enum(["development", "production"]),
    distRoot: z.string().trim().min(1).optional(),
    variantOrigin: originSchema,
    hostname: z.string().trim().min(1).default("127.0.0.1"),
    port: z.number().int().min(0).max(65_535),
  })
  .strict();

const variantOriginMeta =
  /<meta\s+name=(["'])variant-origin\1\s+content=(["'])[^"']*\2\s*\/?>/i;

export interface AppServerConfig {
  api: ApiConfig;
  capturesRoot: string;
  assetRoot: string;
  mode: "development" | "production";
  distRoot?: string;
  variantOrigin: string;
  hostname?: string;
  port: number;
}

function canonicalDirectory(path: string, label: string): string {
  const canonical = realpathSync(resolve(path));
  if (!statSync(canonical).isDirectory())
    throw new TypeError(`${label} must be a directory`);
  return canonical;
}

export function createAppFetchHandler(
  input: AppServerConfig,
): (request: Request) => Promise<Response> {
  const config = configSchema.parse(input);
  const api = createApiFetchHandler(config.api);
  const captures = createCaptureFetchHandler({
    capturesRoot: config.capturesRoot,
  });
  const assets = createCaptureFetchHandler({
    capturesRoot: config.assetRoot,
    routePrefix: "/assets/",
  });
  const distRoot =
    config.mode === "production"
      ? canonicalDirectory(config.distRoot ?? "", "distRoot")
      : null;
  const distAssets =
    distRoot === null
      ? null
      : createCaptureFetchHandler({
          capturesRoot: resolve(distRoot, "assets"),
          routePrefix: "/assets/",
        });
  const trustedParentCsp = [
    `frame-src ${config.variantOrigin}`,
    `child-src ${config.variantOrigin}`,
  ].join("; ");

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request);
    if (url.pathname.startsWith("/captures/")) return captures(request);
    if (url.pathname.startsWith("/assets/")) {
      if (distAssets !== null) {
        const builtAsset = await distAssets(request);
        if (builtAsset.status !== 404) return builtAsset;
      }
      return assets(request);
    }
    if (distRoot === null) {
      return Response.json(
        {
          error: {
            code: "client_not_served",
            message: "Vite serves the client in development",
          },
        },
        { status: 404 },
      );
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json(
        {
          error: {
            code: "method_not_allowed",
            message: "Only GET and HEAD are allowed",
          },
        },
        { status: 405, headers: { Allow: "GET, HEAD" } },
      );
    }
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(url.pathname.slice(1));
      if (relativePath.includes("\\") || relativePath.split("/").includes(".."))
        throw new Error();
    } catch {
      return Response.json(
        { error: { code: "invalid_path", message: "Client path is invalid" } },
        { status: 400 },
      );
    }
    let file = relativePath
      ? await resolveContainedFile(distRoot, relativePath)
      : null;
    if (
      file === null &&
      relativePath !== "" &&
      relativePath.split("/").at(-1)?.includes(".")
    ) {
      return Response.json(
        { error: { code: "not_found", message: "Client asset not found" } },
        { status: 404 },
      );
    }
    file ??= await resolveContainedFile(distRoot, "index.html");
    if (file === null) {
      return Response.json(
        {
          error: {
            code: "client_build_missing",
            message: "Production client index.html is missing",
          },
        },
        { status: 500 },
      );
    }
    const contentType = contentTypeForPath(file);
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (contentType.startsWith("text/html")) {
      headers["Content-Security-Policy"] = trustedParentCsp;
      const html = await Bun.file(file).text();
      if (!variantOriginMeta.test(html)) {
        return Response.json(
          {
            error: {
              code: "variant_origin_marker_missing",
              message:
                "Production client HTML is missing the variant-origin runtime marker",
            },
          },
          { status: 500 },
        );
      }
      const configuredHtml = html.replace(
        variantOriginMeta,
        `<meta name="variant-origin" content="${config.variantOrigin}" />`,
      );
      return request.method === "HEAD"
        ? new Response(null, { headers })
        : new Response(configuredHtml, { headers });
    }
    return request.method === "HEAD"
      ? new Response(null, { headers })
      : new Response(Bun.file(file), { headers });
  };
}

export function startAppServer(input: AppServerConfig): Bun.Server<undefined> {
  const config = configSchema.parse(input);
  const fetch = createAppFetchHandler(config);
  return Bun.serve({ hostname: config.hostname, port: config.port, fetch });
}

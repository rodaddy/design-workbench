import { realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const requestUrlSchema = z.string().url();
const rootSchema = z.string().min(1);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export type StaticErrorCode =
  "internal_error" | "invalid_path" | "method_not_allowed" | "not_found";

export interface StaticError {
  error: {
    code: StaticErrorCode;
    message: string;
  };
}

export interface CaptureHandlerConfig {
  capturesRoot: string;
  routePrefix?: string;
}

function errorResponse(
  status: number,
  code: StaticErrorCode,
  message: string,
  headers?: HeadersInit,
): Response {
  return Response.json({ error: { code, message } } satisfies StaticError, {
    status,
    headers,
  });
}

function canonicalDirectory(input: string, label: string): string {
  const parsed = rootSchema.safeParse(input);
  if (!parsed.success) {
    throw new TypeError(`${label} must be a non-empty path`);
  }

  const canonical = realpathSync(resolve(parsed.data));
  if (!statSync(canonical).isDirectory()) {
    throw new TypeError(`${label} must resolve to a directory`);
  }
  return canonical;
}

function decodedRelativePath(pathname: string, prefix: string): string {
  if (!pathname.startsWith(prefix)) {
    throw new TypeError("Path is outside the configured route");
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    throw new TypeError("Path contains invalid percent encoding");
  }

  if (
    decoded.length === 0 ||
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    isAbsolute(decoded)
  ) {
    throw new TypeError("Path is invalid");
  }

  const segments = decoded.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new TypeError("Path traversal is not allowed");
  }

  return segments.join("/");
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

export async function resolveContainedFile(
  canonicalRoot: string,
  relativePath: string,
): Promise<string | null> {
  const candidate = resolve(canonicalRoot, relativePath);
  if (!isContained(canonicalRoot, candidate)) {
    throw new TypeError("Path traversal is not allowed");
  }

  try {
    const canonicalCandidate = await realpath(candidate);
    if (!isContained(canonicalRoot, canonicalCandidate)) {
      throw new TypeError("Resolved path escapes the configured root");
    }
    const fileStat = await stat(canonicalCandidate);
    return fileStat.isFile() ? canonicalCandidate : null;
  } catch (error) {
    const errorCode =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null;
    if (
      error instanceof TypeError ||
      (errorCode !== "ENOENT" && errorCode !== "ENOTDIR")
    ) {
      throw error;
    }
    return null;
  }
}

export function contentTypeForPath(filePath: string): string {
  return (
    CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream"
  );
}

function captureSecurityHeaders(filePath: string): Record<string, string> {
  const extension = extname(filePath).toLowerCase();
  const headers: Record<string, string> = {
    "Content-Security-Policy":
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    "Content-Type": contentTypeForPath(filePath),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  if (extension === ".htm" || extension === ".html" || extension === ".svg") {
    headers["Content-Disposition"] = "attachment";
  }
  return headers;
}

export function createCaptureFetchHandler(
  config: CaptureHandlerConfig,
): (request: Request) => Promise<Response> {
  const canonicalRoot = canonicalDirectory(config.capturesRoot, "capturesRoot");
  const routePrefix = config.routePrefix ?? "/captures/";
  if (!routePrefix.startsWith("/") || !routePrefix.endsWith("/")) {
    throw new TypeError("routePrefix must start and end with '/'");
  }

  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(
        405,
        "method_not_allowed",
        "Only GET and HEAD are allowed",
        {
          Allow: "GET, HEAD",
        },
      );
    }

    const parsedUrl = requestUrlSchema.safeParse(request.url);
    if (!parsedUrl.success) {
      return errorResponse(400, "invalid_path", "Request URL is invalid");
    }

    try {
      const pathname = new URL(parsedUrl.data).pathname;
      const requestedPath = decodedRelativePath(pathname, routePrefix);
      const filePath = await resolveContainedFile(canonicalRoot, requestedPath);
      if (filePath === null) {
        return errorResponse(404, "not_found", "File not found");
      }

      const headers = captureSecurityHeaders(filePath);
      return request.method === "HEAD"
        ? new Response(null, { status: 200, headers })
        : new Response(Bun.file(filePath), { status: 200, headers });
    } catch (error) {
      if (error instanceof TypeError) {
        return errorResponse(400, "invalid_path", "Requested path is invalid");
      }
      console.error("Capture file serving failed", error);
      return errorResponse(
        500,
        "internal_error",
        "Capture file could not be served",
      );
    }
  };
}

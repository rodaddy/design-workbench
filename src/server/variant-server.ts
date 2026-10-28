import { realpathSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { z } from "zod";

import {
  workbenchTweakManifestSchema,
  workbenchVariantIdSchema,
  WORKBENCH_TWEAK_PROTOCOL,
  WORKBENCH_TWEAK_VERSION,
  type WorkbenchTweakManifest,
} from "../shared/tweaks";
import {
  contentTypeForPath,
  resolveContainedFile,
  type StaticError,
} from "./static-files";

export const VARIANT_TWEAK_BRIDGE_PATH = "/__design-workbench/tweak-bridge.js";

const MAX_TWEAK_MANIFEST_BYTES = 64 * 1024;

const originSchema = z
  .string()
  .url()
  .transform((value, context) => {
    const url = new URL(value);
    if (url.origin !== value.replace(/\/$/, "")) {
      context.addIssue({
        code: "custom",
        message:
          "trustedOrigin must contain only scheme, host, and optional port",
      });
      return z.NEVER;
    }
    return url.origin;
  });

const variantServerConfigSchema = z
  .object({
    generatedVariantsRoot: z.string().min(1),
    trustedOrigins: z.array(originSchema).min(1).optional(),
    trustedOrigin: originSchema.optional(),
    hostname: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(0).max(65_535),
  })
  .superRefine((value, context) => {
    if (
      value.trustedOrigins === undefined &&
      value.trustedOrigin === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "At least one trusted frame-ancestor origin is required",
      });
    }
  });

export interface VariantServerConfig {
  generatedVariantsRoot: string;
  trustedOrigins?: string[];
  trustedOrigin?: string;
  hostname?: string;
  port: number;
}

interface PreparedVariantConfig {
  canonicalRoot: string;
  trustedOrigins: string[];
  hostname: string;
  port: number;
}

function prepareConfig(input: VariantServerConfig): PreparedVariantConfig {
  const parsed = variantServerConfigSchema.parse(input);
  const canonicalRoot = realpathSync(resolve(parsed.generatedVariantsRoot));
  if (!statSync(canonicalRoot).isDirectory()) {
    throw new TypeError("generatedVariantsRoot must resolve to a directory");
  }
  const trustedOrigins = [
    ...(parsed.trustedOrigins ?? []),
    ...(parsed.trustedOrigin === undefined ? [] : [parsed.trustedOrigin]),
  ];
  return {
    canonicalRoot,
    hostname: parsed.hostname,
    port: parsed.port,
    trustedOrigins: [...new Set(trustedOrigins)],
  };
}

function csp(trustedOrigins: readonly string[]): string {
  return [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "navigate-to 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    `frame-ancestors ${trustedOrigins.join(" ")}`,
    "base-uri 'none'",
    "sandbox allow-scripts",
  ].join("; ");
}

function securityHeaders(cspHeader: string): Record<string, string> {
  return {
    "Content-Security-Policy": cspHeader,
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function corsHeaders(
  request: Request,
  trustedOrigins: readonly string[],
): Record<string, string> {
  const requestOrigin = request.headers.get("Origin");
  if (!requestOrigin || !trustedOrigins.includes(requestOrigin)) return {};
  return {
    "Access-Control-Allow-Origin": requestOrigin,
    Vary: "Origin",
  };
}

function jsonError(
  status: number,
  code: StaticError["error"]["code"],
  message: string,
  cspHeader: string,
  extraHeaders?: HeadersInit,
): Response {
  return Response.json({ error: { code, message } } satisfies StaticError, {
    status,
    headers: {
      ...securityHeaders(cspHeader),
      ...extraHeaders,
    },
  });
}

function requestPath(request: Request): string {
  const urlResult = z.string().url().safeParse(request.url);
  if (!urlResult.success) {
    throw new TypeError("Request URL is invalid");
  }

  const rawPath = new URL(urlResult.data).pathname;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new TypeError("Path contains invalid percent encoding");
  }

  if (
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    decoded.includes("//")
  ) {
    throw new TypeError("Path is invalid");
  }
  if (decoded === "/") {
    return "index.html";
  }

  const withoutEdges = decoded.slice(1, decoded.endsWith("/") ? -1 : undefined);
  const segments = withoutEdges.split("/");
  if (
    segments.some(
      (segment) => segment === "." || segment === ".." || segment === "",
    )
  ) {
    throw new TypeError("Path traversal is not allowed");
  }

  if (segments.length === 0) {
    return "index.html";
  }
  if (decoded.endsWith("/")) {
    return `${segments.join("/")}/index.html`;
  }
  return segments.join("/");
}

class InvalidTweakManifestError extends Error {
  constructor() {
    super("Variant tweak manifest is invalid");
    this.name = "InvalidTweakManifestError";
  }
}

async function loadTweakManifest(
  canonicalRoot: string,
  variantId: string,
): Promise<WorkbenchTweakManifest | null> {
  const parsedVariantId = workbenchVariantIdSchema.safeParse(variantId);
  if (!parsedVariantId.success) {
    throw new TypeError("Variant identity is invalid");
  }

  const manifestPath = await resolveContainedFile(
    canonicalRoot,
    `${parsedVariantId.data}/workbench.json`,
  );
  if (manifestPath === null) return null;

  const file = Bun.file(manifestPath);
  if (file.size > MAX_TWEAK_MANIFEST_BYTES) {
    throw new InvalidTweakManifestError();
  }

  try {
    const parsed = workbenchTweakManifestSchema.parse(
      JSON.parse(await file.text()),
    );
    if (parsed.variantId !== parsedVariantId.data) {
      throw new InvalidTweakManifestError();
    }
    return parsed;
  } catch (error) {
    if (error instanceof InvalidTweakManifestError) throw error;
    throw new InvalidTweakManifestError();
  }
}

function variantIdForHtmlPath(relativePath: string): string | null {
  if (![".htm", ".html"].includes(extname(relativePath).toLowerCase())) {
    return null;
  }
  const directory = dirname(relativePath);
  return directory === "." ? null : directory;
}

function injectTweakBridge(html: string, variantId: string): string {
  const bridgeTag = `<script src="${VARIANT_TWEAK_BRIDGE_PATH}?variant=${encodeURIComponent(variantId)}" defer data-workbench-tweak-bridge></script>`;
  if (/<\/head\s*>/i.test(html)) {
    return html.replace(/<\/head\s*>/i, `${bridgeTag}</head>`);
  }
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${bridgeTag}</body>`);
  }
  return `${html}${bridgeTag}`;
}

function bridgeVariantId(request: Request): string {
  const url = new URL(request.url);
  const variants = url.searchParams.getAll("variant");
  if (variants.length !== 1 || [...url.searchParams.keys()].length !== 1) {
    throw new TypeError("Bridge request must identify exactly one variant");
  }
  const result = workbenchVariantIdSchema.safeParse(variants[0]);
  if (!result.success) {
    throw new TypeError("Bridge variant identity is invalid");
  }
  return result.data;
}

function safeScriptJson(input: unknown): string {
  return JSON.stringify(input).replace(
    /[<>&\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function renderTweakBridge(
  manifest: WorkbenchTweakManifest,
  trustedOrigins: readonly string[],
): string {
  const config = safeScriptJson({ manifest, trustedOrigins });
  return `(() => {
  "use strict";
  const config = ${config};
  const controls = new Map(config.manifest.controls.map((control) => [control.id, control]));
  const messageKeys = ["controlId", "type", "value", "variantId", "version"];
  const colorPattern = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
  const motionPreference =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : { matches: false };
  const values = new Map();

  function hasExactMessageKeys(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    return keys.length === messageKeys.length && keys.every((key, index) => key === messageKeys[index]);
  }

  function isStepAligned(value, control) {
    const steps = (value - control.min) / control.step;
    return Math.abs(steps - Math.round(steps)) <= 1e-9;
  }

  function accepts(control, value) {
    if (control.type === "choice") {
      return typeof value === "string" && control.options.some((option) => option.value === value);
    }
    if (control.type === "number") {
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= control.min &&
        value <= control.max &&
        isStepAligned(value, control)
      );
    }
    if (control.type === "color") {
      return typeof value === "string" && colorPattern.test(value);
    }
    return control.type === "boolean" && typeof value === "boolean";
  }

  function serialized(control, value) {
    if (control.type === "number") return \`\${value}\${control.unit}\`;
    if (control.type === "boolean") return value ? "1" : "0";
    return value;
  }

  function apply(control, value) {
    if (control.affectsMotion && motionPreference.matches) {
      document.documentElement.style.removeProperty(control.property);
      return;
    }
    document.documentElement.style.setProperty(control.property, serialized(control, value));
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !config.trustedOrigins.includes(event.origin)) return;
    const message = event.data;
    if (
      !hasExactMessageKeys(message) ||
      message.type !== "${WORKBENCH_TWEAK_PROTOCOL}" ||
      message.version !== ${WORKBENCH_TWEAK_VERSION} ||
      message.variantId !== config.manifest.variantId
    ) {
      return;
    }
    const control = controls.get(message.controlId);
    if (!control || !accepts(control, message.value)) return;
    values.set(control.id, message.value);
    apply(control, message.value);
  });

  const syncMotionPreference = () => {
    for (const control of controls.values()) {
      if (!control.affectsMotion) continue;
      const value = values.get(control.id);
      if (motionPreference.matches) {
        document.documentElement.style.removeProperty(control.property);
      } else if (value !== undefined) {
        apply(control, value);
      }
    }
  };
  if (typeof motionPreference.addEventListener === "function") {
    motionPreference.addEventListener("change", syncMotionPreference);
  }
})();`;
}

export function createVariantFetchHandler(
  input: VariantServerConfig,
): (request: Request) => Promise<Response> {
  const config = prepareConfig(input);
  const cspHeader = csp(config.trustedOrigins);

  return async (request: Request): Promise<Response> => {
    const crossOriginHeaders = corsHeaders(request, config.trustedOrigins);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonError(
        405,
        "method_not_allowed",
        "Only GET and HEAD are allowed",
        cspHeader,
        { ...crossOriginHeaders, Allow: "GET, HEAD" },
      );
    }

    try {
      const url = new URL(request.url);
      if (url.pathname === VARIANT_TWEAK_BRIDGE_PATH) {
        const variantId = bridgeVariantId(request);
        const manifest = await loadTweakManifest(
          config.canonicalRoot,
          variantId,
        );
        if (manifest === null) {
          return jsonError(
            404,
            "not_found",
            "Variant tweak manifest not found",
            cspHeader,
            crossOriginHeaders,
          );
        }
        const headers = {
          ...securityHeaders(cspHeader),
          ...crossOriginHeaders,
          "Cache-Control": "no-store",
          "Content-Type": "text/javascript; charset=utf-8",
        };
        return request.method === "HEAD"
          ? new Response(null, { status: 200, headers })
          : new Response(renderTweakBridge(manifest, config.trustedOrigins), {
              status: 200,
              headers,
            });
      }

      const relativePath = requestPath(request);
      const filePath = await resolveContainedFile(
        config.canonicalRoot,
        relativePath,
      );
      if (filePath === null) {
        return jsonError(
          404,
          "not_found",
          "Variant file not found",
          cspHeader,
          crossOriginHeaders,
        );
      }

      const headers = {
        ...securityHeaders(cspHeader),
        ...crossOriginHeaders,
        "Content-Type": contentTypeForPath(filePath),
      };
      if (request.method === "HEAD") {
        return new Response(null, { status: 200, headers });
      }

      const variantId = variantIdForHtmlPath(relativePath);
      if (variantId === null) {
        return new Response(Bun.file(filePath), { status: 200, headers });
      }
      const manifest = await loadTweakManifest(config.canonicalRoot, variantId);
      if (manifest === null) {
        return new Response(Bun.file(filePath), { status: 200, headers });
      }
      return new Response(
        injectTweakBridge(await Bun.file(filePath).text(), variantId),
        {
          status: 200,
          headers: { ...headers, "Cache-Control": "no-store" },
        },
      );
    } catch (error) {
      if (error instanceof TypeError) {
        return jsonError(
          400,
          "invalid_path",
          "Requested variant path is invalid",
          cspHeader,
          crossOriginHeaders,
        );
      }
      if (error instanceof InvalidTweakManifestError) {
        return jsonError(
          500,
          "internal_error",
          "Variant tweak manifest is invalid",
          cspHeader,
          crossOriginHeaders,
        );
      }
      console.error("Variant file serving failed", error);
      return jsonError(
        500,
        "internal_error",
        "Variant file could not be served",
        cspHeader,
        crossOriginHeaders,
      );
    }
  };
}

export function startVariantServer(
  input: VariantServerConfig,
): Bun.Server<undefined> {
  const config = prepareConfig(input);
  const fetch = createVariantFetchHandler(input);
  return Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch,
  });
}

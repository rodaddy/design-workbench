import { z } from "zod";

export const VARIANT_IFRAME_SANDBOX = "allow-scripts";
export const DEFAULT_VARIANT_PORT = 3001;

type ProbeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function originOnly(value: string, label: string): string {
  const parsed = z.string().url().parse(value);
  const url = new URL(parsed);
  if (url.origin !== parsed.replace(/\/$/, "")) {
    throw new TypeError(
      `${label} must contain only scheme, host, and optional port.`,
    );
  }
  return url.origin;
}

export function defaultVariantOrigin(appUrl: string): string {
  const trusted = new URL(appUrl);
  return `${trusted.protocol}//${trusted.hostname}:${DEFAULT_VARIANT_PORT}`;
}

export function variantUrl(
  artifactPath: string,
  variantOrigin: string,
  trustedOrigin: string,
): string {
  const isolatedOrigin = originOnly(variantOrigin, "Variant origin");
  const appOrigin = originOnly(trustedOrigin, "Trusted origin");
  if (isolatedOrigin === appOrigin) {
    throw new TypeError(
      "VARIANT_ORIGIN_NOT_ISOLATED: Variant and trusted origins must differ.",
    );
  }
  const path = z.string().trim().min(1).parse(artifactPath);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError(
      "VARIANT_ARTIFACT_PATH_INVALID: Artifact path must be a contained relative path.",
    );
  }
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return new URL(`/${encodedPath}/index.html`, isolatedOrigin).toString();
}

export async function probeVariantAvailability(
  url: string,
  fetchImpl: ProbeFetch = fetch,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "HEAD",
      mode: "cors",
      credentials: "omit",
      signal,
    });
  } catch (error) {
    throw new Error(
      "VARIANT_SERVER_UNAVAILABLE: Could not verify the artifact on the isolated variant origin.",
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(
      `VARIANT_ARTIFACT_UNAVAILABLE: Variant server returned status ${response.status}.`,
    );
  }
}

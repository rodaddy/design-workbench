import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const byteLimitSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const multipartInputSchema = z
  .object({
    bytes: z.instanceof(Uint8Array),
    contentType: z.string().trim().min(1),
    fieldName: z.string().trim().min(1).default("file"),
  })
  .strict();
const storageInputSchema = z.object({
  assetRoot: z.string().trim().min(1),
  bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength > 0),
  filename: z.string().trim().min(1),
  mimeType: z.string().trim().min(1),
});

export type UploadErrorCode =
  | "BODY_TOO_LARGE"
  | "INVALID_CONTENT_LENGTH"
  | "INVALID_MULTIPART"
  | "EMPTY_UPLOAD"
  | "MULTIPLE_FILES"
  | "UNEXPECTED_FIELD"
  | "UNSUPPORTED_FILE_TYPE"
  | "MIME_EXTENSION_MISMATCH"
  | "INVALID_FILE_SIGNATURE"
  | "INVALID_STORAGE_PATH"
  | "STORAGE_IO_ERROR";

export class UploadError extends Error {
  constructor(
    readonly code: UploadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UploadError";
  }
}

type SupportedMime =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"
  | "video/mp4"
  | "video/webm";

const EXTENSION_TO_MIME: Readonly<Record<string, SupportedMime>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export interface ExtractedUpload {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimeType: SupportedMime;
  readonly extension: string;
}

export interface StoredUpload extends ExtractedUpload {
  readonly sha256: string;
  readonly relativePath: string;
  readonly absolutePath: string;
}

function asUploadError(
  error: unknown,
  code: UploadErrorCode,
  message: string,
): UploadError {
  return error instanceof UploadError
    ? error
    : new UploadError(code, message, { cause: error });
}

export async function readBoundedRequestBody(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array> {
  const parsedLimit = byteLimitSchema.safeParse(maximumBytes);
  if (!parsedLimit.success) {
    throw new UploadError("INVALID_CONTENT_LENGTH", "Body limit is invalid", {
      cause: parsedLimit.error,
    });
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9]\d*)$/.test(declaredLength)) {
      throw new UploadError(
        "INVALID_CONTENT_LENGTH",
        "Content-Length must be a non-negative integer",
      );
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length)) {
      throw new UploadError(
        "INVALID_CONTENT_LENGTH",
        "Content-Length is too large",
      );
    }
    if (length > parsedLimit.data) {
      await request.body?.cancel("body limit exceeded");
      throw new UploadError(
        "BODY_TOO_LARGE",
        "Request body exceeds the configured limit",
      );
    }
  }

  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > parsedLimit.data) {
        await reader.cancel("body limit exceeded");
        throw new UploadError(
          "BODY_TOO_LARGE",
          "Request body exceeds the configured limit",
        );
      }
      chunks.push(result.value);
    }
  } catch (error) {
    throw asUploadError(
      error,
      "INVALID_MULTIPART",
      "Request body could not be read",
    );
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function hasPrefix(
  bytes: Uint8Array,
  expected: readonly number[],
  offset = 0,
): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function hasAscii(bytes: Uint8Array, value: string, offset = 0): boolean {
  return [...value].every(
    (character, index) => bytes[offset + index] === character.charCodeAt(0),
  );
}

function hasValidSignature(
  bytes: Uint8Array,
  mimeType: SupportedMime,
): boolean {
  switch (mimeType) {
    case "image/png":
      return hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return hasPrefix(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return hasAscii(bytes, "GIF87a") || hasAscii(bytes, "GIF89a");
    case "image/webp":
      return hasAscii(bytes, "RIFF") && hasAscii(bytes, "WEBP", 8);
    case "video/webm":
      return hasPrefix(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case "video/mp4":
      return bytes.byteLength >= 12 && hasAscii(bytes, "ftyp", 4);
  }
}

function validateFile(
  filenameInput: string,
  mimeTypeInput: string,
  bytes: Uint8Array,
): ExtractedUpload {
  const filename = filenameInput.trim();
  const extension = extname(filename).toLowerCase();
  const expectedMime = EXTENSION_TO_MIME[extension];
  if (!expectedMime) {
    throw new UploadError(
      "UNSUPPORTED_FILE_TYPE",
      "File extension is not an allowed image or video type",
    );
  }
  if (mimeTypeInput.toLowerCase() !== expectedMime) {
    throw new UploadError(
      "MIME_EXTENSION_MISMATCH",
      "Declared MIME type does not match the filename extension",
    );
  }

  if (bytes.byteLength === 0) {
    throw new UploadError("EMPTY_UPLOAD", "Uploaded file is empty");
  }
  if (!hasValidSignature(bytes, expectedMime)) {
    throw new UploadError(
      "INVALID_FILE_SIGNATURE",
      "File contents do not match the declared file type",
    );
  }
  return { bytes, filename, mimeType: expectedMime, extension };
}

export async function extractSingleFileMultipart(input: {
  bytes: Uint8Array;
  contentType: string;
  fieldName?: string;
}): Promise<ExtractedUpload> {
  const parsed = multipartInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new UploadError(
      "INVALID_MULTIPART",
      "A valid multipart content type is required",
      { cause: parsed.error },
    );
  }
  const boundaryMatch =
    /^multipart\/form-data\s*;\s*boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))\s*$/i.exec(
      parsed.data.contentType,
    );
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) {
    throw new UploadError(
      "INVALID_MULTIPART",
      "A valid multipart boundary is required",
    );
  }

  const body = Buffer.from(parsed.data.bytes);
  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = 0;
  let upload: ExtractedUpload | null = null;
  while (true) {
    if (!body.subarray(cursor, cursor + delimiter.length).equals(delimiter)) {
      throw new UploadError(
        "INVALID_MULTIPART",
        "Multipart delimiter is invalid",
      );
    }
    cursor += delimiter.length;
    if (body.subarray(cursor, cursor + 2).toString("latin1") === "--") {
      break;
    }
    if (body.subarray(cursor, cursor + 2).toString("latin1") !== "\r\n") {
      throw new UploadError(
        "INVALID_MULTIPART",
        "Multipart delimiter is malformed",
      );
    }
    cursor += 2;
    const headerEnd = body.indexOf("\r\n\r\n", cursor, "latin1");
    if (headerEnd < 0) {
      throw new UploadError(
        "INVALID_MULTIPART",
        "Multipart headers are incomplete",
      );
    }
    const headers = body.subarray(cursor, headerEnd).toString("latin1");
    cursor = headerEnd + 4;
    const nextDelimiter = body.indexOf(
      Buffer.from(`\r\n--${boundary}`),
      cursor,
    );
    if (nextDelimiter < 0) {
      throw new UploadError(
        "INVALID_MULTIPART",
        "Multipart body is incomplete",
      );
    }

    const disposition =
      /^content-disposition:\s*form-data\s*;\s*name="([^"]+)"(?:\s*;\s*filename="([^"]*)")?\s*$/im.exec(
        headers,
      );
    const name = disposition?.[1];
    const filename = disposition?.[2];
    if (!name || name !== parsed.data.fieldName) {
      throw new UploadError(
        "UNEXPECTED_FIELD",
        `Unexpected multipart field '${name ?? ""}'`,
      );
    }
    if (filename === undefined) {
      throw new UploadError(
        "UNEXPECTED_FIELD",
        "Upload field must contain a file",
      );
    }
    const mimeType = /^content-type:\s*([^\r\n;]+)\s*$/im
      .exec(headers)?.[1]
      ?.trim();
    if (!mimeType) {
      throw new UploadError(
        "UNSUPPORTED_FILE_TYPE",
        "Uploaded file MIME type is required",
      );
    }
    if (upload !== null) {
      throw new UploadError(
        "MULTIPLE_FILES",
        "Exactly one uploaded file is allowed",
      );
    }
    upload = validateFile(
      filename,
      mimeType,
      new Uint8Array(body.subarray(cursor, nextDelimiter)),
    );
    cursor = nextDelimiter + 2;
  }
  if (upload === null) {
    throw new UploadError(
      "EMPTY_UPLOAD",
      "Exactly one uploaded file is required",
    );
  }
  return upload;
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

export async function storeContentAddressedUpload(input: {
  assetRoot: string;
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}): Promise<StoredUpload> {
  const parsed = storageInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new UploadError(
      "INVALID_STORAGE_PATH",
      "Stored upload input is invalid",
      {
        cause: parsed.error,
      },
    );
  }

  const validated = validateFile(
    parsed.data.filename,
    parsed.data.mimeType,
    parsed.data.bytes,
  );
  const sha256 = createHash("sha256").update(validated.bytes).digest("hex");
  const relativePath = `${sha256.slice(0, 2)}/${sha256}${validated.extension}`;

  try {
    await mkdir(resolve(parsed.data.assetRoot), { recursive: true });
    const canonicalRoot = await realpath(resolve(parsed.data.assetRoot));
    const parent = resolve(canonicalRoot, sha256.slice(0, 2));
    if (!isContained(canonicalRoot, parent)) {
      throw new UploadError(
        "INVALID_STORAGE_PATH",
        "Asset path escapes its root",
      );
    }
    await mkdir(parent, { recursive: true });
    const canonicalParent = await realpath(parent);
    if (!isContained(canonicalRoot, canonicalParent)) {
      throw new UploadError(
        "INVALID_STORAGE_PATH",
        "Asset path escapes its root",
      );
    }
    const absolutePath = resolve(
      canonicalParent,
      `${sha256}${validated.extension}`,
    );
    if (!isContained(canonicalRoot, absolutePath)) {
      throw new UploadError(
        "INVALID_STORAGE_PATH",
        "Asset path escapes its root",
      );
    }

    try {
      const handle = await open(absolutePath, "wx");
      try {
        await handle.writeFile(validated.bytes);
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : null;
      if (code !== "EEXIST") throw error;
      const existing = await readFile(absolutePath);
      const existingHash = createHash("sha256").update(existing).digest("hex");
      if (existingHash !== sha256) {
        throw new UploadError(
          "STORAGE_IO_ERROR",
          "Existing content-addressed asset does not match its hash",
        );
      }
    }

    return { ...validated, sha256, relativePath, absolutePath };
  } catch (error) {
    throw asUploadError(
      error,
      "STORAGE_IO_ERROR",
      "Uploaded asset could not be stored",
    );
  }
}

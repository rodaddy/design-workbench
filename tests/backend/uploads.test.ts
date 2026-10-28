import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";

import {
  extractSingleFileMultipart,
  readBoundedRequestBody,
  storeContentAddressedUpload,
  UploadError,
} from "../../src/server/uploads";

const TEMP_ROOT = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench",
  `uploads-${process.pid}-${Date.now()}`,
);
const ARCHIVE_ROOT = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/_archive",
);

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);

async function multipart(
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
  extra?: "field" | "file",
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const boundary = "design-workbench-test-boundary";
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ),
    bytes,
    encoder.encode("\r\n"),
  ];
  if (extra === "field") {
    chunks.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\nnope\r\n`,
      ),
    );
  }
  if (extra === "file") {
    chunks.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="second.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      PNG_BYTES,
      encoder.encode("\r\n"),
    );
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes: body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function expectCode(error: unknown, code: UploadError["code"]): void {
  expect(error).toBeInstanceOf(UploadError);
  expect((error as UploadError).code).toBe(code);
}

async function expectRejectedCode(
  action: Promise<unknown>,
  code: UploadError["code"],
): Promise<void> {
  try {
    await action;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expectCode(error, code);
  }
}

afterAll(async () => {
  await mkdir(ARCHIVE_ROOT, { recursive: true });
  await rename(TEMP_ROOT, resolve(ARCHIVE_ROOT, `uploads-${Date.now()}`)).catch(
    (error: unknown) => {
      const code =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : null;
      if (code !== "ENOENT") throw error;
    },
  );
});

describe("bounded request bodies", () => {
  test("rejects an oversized Content-Length before consuming the stream", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([1]));
      },
    });
    const request = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "Content-Length": "101" },
      body,
    });

    await expectRejectedCode(
      readBoundedRequestBody(request, 100),
      "BODY_TOO_LARGE",
    );
    expect(pulls).toBe(0);
  });

  test("rejects streamed bytes over the limit when length is absent", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        controller.close();
      },
    });
    const request = new Request("http://localhost/upload", {
      method: "POST",
      body,
    });

    await expectRejectedCode(
      readBoundedRequestBody(request, 10),
      "BODY_TOO_LARGE",
    );
  });
});

describe("multipart upload validation", () => {
  test("rejects MIME/extension mismatch and signature spoofing", async () => {
    const mismatch = await multipart("image.jpg", "image/png", PNG_BYTES);
    await expectRejectedCode(
      extractSingleFileMultipart(mismatch),
      "MIME_EXTENSION_MISMATCH",
    );

    const spoof = await multipart(
      "image.png",
      "image/png",
      new TextEncoder().encode("not a png"),
    );
    await expectRejectedCode(
      extractSingleFileMultipart(spoof),
      "INVALID_FILE_SIGNATURE",
    );
  });

  test("rejects unexpected fields, multiple files, and traversal-ish names", async () => {
    const unexpected = await multipart(
      "image.png",
      "image/png",
      PNG_BYTES,
      "field",
    );
    await expectRejectedCode(
      extractSingleFileMultipart(unexpected),
      "UNEXPECTED_FIELD",
    );

    const multiple = await multipart(
      "image.png",
      "image/png",
      PNG_BYTES,
      "file",
    );
    await expectRejectedCode(
      extractSingleFileMultipart(multiple),
      "MULTIPLE_FILES",
    );

    const traversal = await multipart(
      "../../image.png",
      "image/png",
      PNG_BYTES,
    );
    const extracted = await extractSingleFileMultipart(traversal);
    const stored = await storeContentAddressedUpload({
      assetRoot: resolve(TEMP_ROOT, "assets"),
      ...extracted,
    });
    expect(stored.relativePath).not.toContain("..");
    expect(stored.absolutePath.startsWith(resolve(TEMP_ROOT, "assets"))).toBe(
      true,
    );
  });
});

test("stores valid bytes by hash and reuses the same path idempotently", async () => {
  const upload = await multipart("sample.png", "image/png", PNG_BYTES);
  const extracted = await extractSingleFileMultipart(upload);
  const first = await storeContentAddressedUpload({
    assetRoot: resolve(TEMP_ROOT, "assets"),
    ...extracted,
  });
  const second = await storeContentAddressedUpload({
    assetRoot: resolve(TEMP_ROOT, "assets"),
    ...extracted,
  });

  expect(first.sha256).toHaveLength(64);
  expect(first.relativePath).toBe(
    `${first.sha256.slice(0, 2)}/${first.sha256}.png`,
  );
  expect(second.absolutePath).toBe(first.absolutePath);
  expect(await Bun.file(first.absolutePath).arrayBuffer()).toEqual(
    PNG_BYTES.buffer,
  );
});

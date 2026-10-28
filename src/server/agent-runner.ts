import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const requestSchema = z.object({
  sessionId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(200_000),
  cwd: z.string().trim().min(1),
  resume: z.boolean().default(false),
  mode: z.enum(["review", "build"]).default("review"),
  model: z.string().trim().min(1).max(100).default("fable"),
  effort: z.enum(["low", "medium", "high"]).default("high"),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(30 * 60_000)
    .default(10 * 60_000),
  maxOutputBytes: z
    .number()
    .int()
    .min(1_024)
    .max(10 * 1024 * 1024)
    .default(2 * 1024 * 1024),
});

export type LocalAgentRequest = z.input<typeof requestSchema>;

export type LocalAgentEvent =
  | { type: "text"; text: string }
  | { type: "status"; status: string }
  | { type: "raw"; value: Record<string, unknown> };

export interface LocalAgentResult {
  sessionId: string;
  text: string;
  exitCode: number;
  events: LocalAgentEvent[];
}

export type LocalAgentErrorCode =
  | "AGENT_ACTIVE"
  | "AGENT_CANCELLED"
  | "AGENT_CONFIG_INVALID"
  | "AGENT_FAILED"
  | "AGENT_OUTPUT_LIMIT"
  | "AGENT_PATH_FORBIDDEN"
  | "AGENT_STREAM_INVALID"
  | "AGENT_TIMEOUT";

export class LocalAgentError extends Error {
  constructor(
    readonly code: LocalAgentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalAgentError";
  }
}

export interface LocalAgentRunnerConfig {
  executable?: string;
  reviewRoots: readonly string[];
  buildRoots: readonly string[];
}

const LOCAL_AGENT_SYSTEM_PROMPT = [
  "You are a focused local Design Workbench implementation agent.",
  "Follow the operator request directly and read project-local skill files when named.",
  "Do not invoke slash commands, skill setup scripts, context initialization, or concept-selection workflows.",
  "Work only inside the supplied working directory and use only the provided tools.",
  "Do not delegate, launch workflows or subagents, browse, deploy, or contact external services.",
  "Complete the requested file edits, validate the required artifact, then report concisely.",
].join(" ");

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function canonicalRoots(roots: readonly string[], label: string): string[] {
  if (roots.length === 0) {
    throw new LocalAgentError(
      "AGENT_CONFIG_INVALID",
      `${label} must contain at least one trusted directory`,
    );
  }
  try {
    return roots.map((root) => realpathSync(resolve(root)));
  } catch (error) {
    throw new LocalAgentError(
      "AGENT_CONFIG_INVALID",
      `${label} contains an unavailable directory`,
      { cause: error },
    );
  }
}

function textFromEvent(value: Record<string, unknown>): string {
  if (value.type === "result" && typeof value.result === "string") {
    return value.result;
  }
  if (value.type === "stream_event") {
    const event = value.event;
    if (typeof event === "object" && event !== null) {
      const delta = (event as Record<string, unknown>).delta;
      if (typeof delta === "object" && delta !== null) {
        const text = (delta as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
    }
  }
  if (value.type === "assistant") {
    const message = value.message;
    if (typeof message === "object" && message !== null) {
      const content = (message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        return content
          .map((block) =>
            typeof block === "object" &&
            block !== null &&
            typeof (block as Record<string, unknown>).text === "string"
              ? String((block as Record<string, unknown>).text)
              : "",
          )
          .join("");
      }
    }
  }
  return "";
}

export function parseLocalAgentLine(line: string): {
  event: LocalAgentEvent;
  text: string;
  final: boolean;
  sessionId?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new LocalAgentError(
      "AGENT_STREAM_INVALID",
      "Local agent returned malformed stream data",
      { cause: error },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LocalAgentError(
      "AGENT_STREAM_INVALID",
      "Local agent returned an invalid stream event",
    );
  }
  const value = parsed as Record<string, unknown>;
  const text = textFromEvent(value);
  const sessionId =
    typeof value.session_id === "string" ? value.session_id : undefined;
  if (text)
    return {
      event: { type: "text", text },
      text,
      final: value.type === "result",
      sessionId,
    };
  if (typeof value.type === "string") {
    return {
      event: { type: "status", status: value.type },
      text: "",
      final: false,
      sessionId,
    };
  }
  return {
    event: { type: "raw", value },
    text: "",
    final: false,
    sessionId,
  };
}

export class LocalAgentRunner {
  private readonly executable: string;
  private readonly reviewRoots: string[];
  private readonly buildRoots: string[];
  private readonly activeSessions = new Set<string>();

  constructor(config: LocalAgentRunnerConfig) {
    this.executable = config.executable?.trim() || "claude";
    this.reviewRoots = canonicalRoots(config.reviewRoots, "reviewRoots");
    this.buildRoots = canonicalRoots(config.buildRoots, "buildRoots");
  }

  private canonicalWorkingDirectory(
    path: string,
    mode: "review" | "build",
  ): string {
    let candidate: string;
    try {
      candidate = realpathSync(resolve(path));
    } catch (error) {
      throw new LocalAgentError(
        "AGENT_PATH_FORBIDDEN",
        "Local agent working directory is unavailable",
        { cause: error },
      );
    }
    const roots = mode === "build" ? this.buildRoots : this.reviewRoots;
    if (!roots.some((root) => isContained(root, candidate))) {
      throw new LocalAgentError(
        "AGENT_PATH_FORBIDDEN",
        `Local agent ${mode} directory is outside its configured roots`,
      );
    }
    return candidate;
  }

  buildArguments(input: LocalAgentRequest): string[] {
    const request = requestSchema.parse(input);
    const permissionMode = request.mode === "build" ? "acceptEdits" : "plan";
    const tools =
      request.mode === "build"
        ? "Read,Write,Edit,Glob,Grep,Bash"
        : "Read,Glob,Grep";
    return [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-chrome",
      "--system-prompt",
      LOCAL_AGENT_SYSTEM_PROMPT,
      "--model",
      request.model,
      "--effort",
      request.effort,
      "--permission-mode",
      permissionMode,
      "--tools",
      tools,
      ...(request.resume
        ? ["--resume", request.sessionId]
        : ["--session-id", request.sessionId]),
      "--",
      request.prompt,
    ];
  }

  async run(
    input: LocalAgentRequest,
    options: {
      signal?: AbortSignal;
      onEvent?: (event: LocalAgentEvent) => void;
    } = {},
  ): Promise<LocalAgentResult> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) {
      throw new LocalAgentError(
        "AGENT_CONFIG_INVALID",
        "Local agent request is invalid",
        { cause: parsed.error },
      );
    }
    const request = parsed.data;
    if (this.activeSessions.has(request.sessionId)) {
      throw new LocalAgentError(
        "AGENT_ACTIVE",
        "This local agent session already has an active run",
      );
    }
    const cwd = this.canonicalWorkingDirectory(request.cwd, request.mode);
    if (options.signal?.aborted) {
      throw new LocalAgentError(
        "AGENT_CANCELLED",
        "Local agent run was cancelled",
      );
    }

    this.activeSessions.add(request.sessionId);
    const process = Bun.spawn(
      [this.executable, ...this.buildArguments(request)],
      {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let timedOut = false;
    let cancelled = false;
    const stop = () => process.kill("SIGTERM");
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, request.timeoutMs);

    const events: LocalAgentEvent[] = [];
    const textParts: string[] = [];
    let finalText = "";
    let observedBytes = 0;
    let buffer = "";
    const decoder = new TextDecoder();

    try {
      const reader = process.stdout.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        observedBytes += value.byteLength;
        if (observedBytes > request.maxOutputBytes) {
          stop();
          throw new LocalAgentError(
            "AGENT_OUTPUT_LIMIT",
            "Local agent output exceeded its configured limit",
          );
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsedLine = parseLocalAgentLine(line);
          events.push(parsedLine.event);
          if (parsedLine.text) {
            if (parsedLine.final) finalText = parsedLine.text;
            else textParts.push(parsedLine.text);
          }
          options.onEvent?.(parsedLine.event);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const parsedLine = parseLocalAgentLine(buffer);
        events.push(parsedLine.event);
        if (parsedLine.text) {
          if (parsedLine.final) finalText = parsedLine.text;
          else textParts.push(parsedLine.text);
        }
        options.onEvent?.(parsedLine.event);
      }
      const exitCode = await process.exited;
      if (cancelled || options.signal?.aborted) {
        throw new LocalAgentError(
          "AGENT_CANCELLED",
          "Local agent run was cancelled",
        );
      }
      if (timedOut) {
        throw new LocalAgentError("AGENT_TIMEOUT", "Local agent run timed out");
      }
      if (exitCode !== 0) {
        throw new LocalAgentError(
          "AGENT_FAILED",
          `Local agent exited with status ${exitCode}`,
        );
      }
      const streamedText = textParts.join("");
      return {
        sessionId: request.sessionId,
        text:
          finalText && finalText.startsWith(streamedText)
            ? finalText
            : `${streamedText}${finalText}`,
        exitCode,
        events,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      this.activeSessions.delete(request.sessionId);
    }
  }
}

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const identifier = z.string().trim().min(1).max(200);
const jsonObject = z.record(z.string(), z.unknown());
const createRoundSchema = z
  .object({
    stage: z.enum(["wide-net", "refinement", "assets", "tuning"]),
    prompt: z.string().max(200_000).default(""),
    payload: jsonObject.default({}),
    comparisonId: identifier.nullable().default(null),
    parentRoundId: identifier.nullable().default(null),
    idempotencyKey: identifier,
  })
  .strict();
const createSessionSchema = z
  .object({
    roundId: identifier.nullable().default(null),
    metadata: jsonObject.default({}),
    idempotencyKey: identifier,
  })
  .strict();
const configureDirectionsSchema = z
  .array(
    z
      .object({
        title: z.string().trim().min(1).max(300),
        aestheticFamily: z.string().trim().min(1).max(300),
        referenceIds: z.array(identifier).max(20).default([]),
      })
      .strict(),
  )
  .min(1)
  .max(5);
const createSelectionSchema = z
  .object({
    directionKey: identifier,
    comparisonDirectionId: identifier.nullable().default(null),
    title: z.string().trim().min(1).max(300),
    rationale: z.string().max(20_000).default(""),
    position: z.number().int().nonnegative(),
    payload: jsonObject.default({}),
    idempotencyKey: identifier,
  })
  .strict();
const createRefinementSchema = z
  .object({
    comparisonId: identifier,
    directionId: identifier,
    idempotencyKey: z.string().trim().min(1).max(180),
  })
  .strict();

export class StudioError extends Error {
  constructor(
    readonly code:
      | "STUDIO_CONFLICT"
      | "STUDIO_DATA_INVALID"
      | "STUDIO_INVALID_INPUT"
      | "STUDIO_NOT_FOUND",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StudioError";
  }
}

export interface StudioRound {
  id: string;
  projectId: string;
  sequence: number;
  stage: "wide-net" | "refinement" | "assets" | "tuning";
  comparisonId: string | null;
  status: "draft" | "running" | "completed" | "cancelled";
  prompt: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface StudioMessage {
  id: string;
  sessionId: string;
  runId: string | null;
  sequence: number;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface StudioSession {
  id: string;
  projectId: string;
  roundId: string | null;
  status: "open" | "completed" | "failed" | "cancelled";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  messages: StudioMessage[];
}

type RoundRow = {
  id: string;
  project_id: string;
  sequence: number;
  stage: StudioRound["stage"];
  comparison_id: string | null;
  status: StudioRound["status"];
  prompt: string;
  payload: string;
  created_at: string;
  updated_at: string;
};
type SessionRow = {
  id: string;
  project_id: string;
  round_id: string | null;
  status: StudioSession["status"];
  metadata: string;
  created_at: string;
  updated_at: string;
};
type MessageRow = {
  id: string;
  session_id: string;
  run_id: string | null;
  sequence: number;
  role: StudioMessage["role"];
  content: string;
  metadata: string;
  created_at: string;
};

function parseObject(value: string, field: string): Record<string, unknown> {
  try {
    return jsonObject.parse(JSON.parse(value));
  } catch (error) {
    throw new StudioError("STUDIO_DATA_INVALID", `Stored ${field} is invalid`, {
      cause: error,
    });
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class StudioService {
  constructor(private readonly database: Database) {}

  private requireProject(projectId: string): void {
    if (
      !this.database
        .query<{ id: string }, [string]>(
          "SELECT id FROM site_projects WHERE id = ?",
        )
        .get(projectId)
    ) {
      throw new StudioError(
        "STUDIO_NOT_FOUND",
        "Studio project does not exist",
      );
    }
  }

  private round(row: RoundRow): StudioRound {
    return {
      id: row.id,
      projectId: row.project_id,
      sequence: row.sequence,
      stage: row.stage,
      comparisonId: row.comparison_id,
      status: row.status,
      prompt: row.prompt,
      payload: parseObject(row.payload, "round payload"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listRounds(projectIdInput: unknown): StudioRound[] {
    const projectId = identifier.parse(projectIdInput);
    this.requireProject(projectId);
    return this.database
      .query<RoundRow, [string]>(
        "SELECT * FROM exploration_rounds WHERE project_id = ? ORDER BY sequence, id",
      )
      .all(projectId)
      .map((row) => this.round(row));
  }

  createRound(projectIdInput: unknown, input: unknown): StudioRound {
    const projectId = identifier.parse(projectIdInput);
    const parsed = createRoundSchema.safeParse(input);
    if (!parsed.success) {
      throw new StudioError("STUDIO_INVALID_INPUT", "Round input is invalid", {
        cause: parsed.error,
      });
    }
    this.requireProject(projectId);
    const value = parsed.data;
    const requestFingerprint = fingerprint({ projectId, ...value });
    const existing = this.database
      .query<RoundRow & { request_fingerprint: string }, [string, string]>(
        "SELECT * FROM exploration_rounds WHERE project_id = ? AND idempotency_key = ?",
      )
      .get(projectId, value.idempotencyKey);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw new StudioError(
          "STUDIO_CONFLICT",
          "Round idempotency key was used for different input",
        );
      }
      return this.round(existing);
    }
    if (value.parentRoundId) {
      const parent = this.database
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM exploration_rounds WHERE project_id = ? AND id = ?",
        )
        .get(projectId, value.parentRoundId);
      if (!parent) {
        throw new StudioError(
          "STUDIO_NOT_FOUND",
          "Parent round does not exist",
        );
      }
    }
    if (value.comparisonId) {
      const comparison = this.database
        .query<{ id: string }, [string]>(
          "SELECT id FROM comparisons WHERE id = ?",
        )
        .get(value.comparisonId);
      if (!comparison) {
        throw new StudioError("STUDIO_NOT_FOUND", "Comparison does not exist");
      }
    }
    const sequence =
      (this.database
        .query<{ value: number | null }, [string]>(
          "SELECT MAX(sequence) AS value FROM exploration_rounds WHERE project_id = ?",
        )
        .get(projectId)?.value ?? 0) + 1;
    const id = randomUUID();
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      this.database
        .query(
          `INSERT INTO exploration_rounds (
            id, project_id, sequence, stage, comparison_id, status, prompt,
            payload, idempotency_key, request_fingerprint, version, created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          projectId,
          sequence,
          value.stage,
          value.comparisonId,
          value.prompt,
          JSON.stringify(value.payload),
          value.idempotencyKey,
          requestFingerprint,
          now,
          now,
        );
      this.database
        .query(
          `INSERT INTO exploration_round_lineage (
            project_id, ancestor_round_id, descendant_round_id, depth, created_at
          ) VALUES (?, ?, ?, 0, ?)`,
        )
        .run(projectId, id, id, now);
      if (value.parentRoundId) {
        this.database
          .query(
            `INSERT INTO exploration_round_lineage (
              project_id, ancestor_round_id, descendant_round_id, depth, created_at
            )
            SELECT project_id, ancestor_round_id, ?, depth + 1, ?
            FROM exploration_round_lineage
            WHERE project_id = ? AND descendant_round_id = ?`,
          )
          .run(id, now, projectId, value.parentRoundId);
      }
    });
    transaction.immediate();
    const row = this.database
      .query<RoundRow, [string]>(
        "SELECT * FROM exploration_rounds WHERE id = ?",
      )
      .get(id);
    if (!row)
      throw new StudioError("STUDIO_DATA_INVALID", "Round was not persisted");
    return this.round(row);
  }

  configureDirections(
    projectIdInput: unknown,
    roundIdInput: unknown,
    input: unknown,
  ): void {
    const projectId = identifier.parse(projectIdInput);
    const roundId = identifier.parse(roundIdInput);
    const directions = configureDirectionsSchema.safeParse(input);
    if (!directions.success) {
      throw new StudioError(
        "STUDIO_INVALID_INPUT",
        "Direction configuration is invalid",
        { cause: directions.error },
      );
    }
    const round = this.database
      .query<{ comparison_id: string | null }, [string, string]>(
        `SELECT comparison_id FROM exploration_rounds
         WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, roundId);
    if (!round)
      throw new StudioError("STUDIO_NOT_FOUND", "Round does not exist");
    if (!round.comparison_id) {
      throw new StudioError(
        "STUDIO_CONFLICT",
        "Round is not linked to a comparison",
      );
    }
    const stored = this.database
      .query<{ id: string; position: number }, [string]>(
        `SELECT id, position FROM aesthetic_directions
         WHERE comparison_id = ? ORDER BY position, id`,
      )
      .all(round.comparison_id);
    if (stored.length !== directions.data.length) {
      throw new StudioError(
        "STUDIO_CONFLICT",
        "Direction count does not match the comparison",
      );
    }
    const update = this.database.transaction(() => {
      stored.forEach((direction, index) => {
        const configured = directions.data[index];
        if (!configured) return;
        this.database
          .query(
            `UPDATE aesthetic_directions
             SET title = ?, metadata = ?
             WHERE id = ? AND comparison_id = ?`,
          )
          .run(
            configured.title,
            JSON.stringify({
              aestheticFamily: configured.aestheticFamily,
              referenceIds: configured.referenceIds,
            }),
            direction.id,
            round.comparison_id,
          );
      });
    });
    update.immediate();
  }

  createSelection(
    projectIdInput: unknown,
    roundIdInput: unknown,
    input: unknown,
  ) {
    const projectId = identifier.parse(projectIdInput);
    const roundId = identifier.parse(roundIdInput);
    const parsed = createSelectionSchema.safeParse(input);
    if (!parsed.success) {
      throw new StudioError(
        "STUDIO_INVALID_INPUT",
        "Selection input is invalid",
        {
          cause: parsed.error,
        },
      );
    }
    const round = this.database
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM exploration_rounds WHERE project_id = ? AND id = ?",
      )
      .get(projectId, roundId);
    if (!round)
      throw new StudioError("STUDIO_NOT_FOUND", "Round does not exist");
    const value = parsed.data;
    const id = randomUUID();
    const now = new Date().toISOString();
    const requestFingerprint = fingerprint({ projectId, roundId, ...value });
    try {
      this.database
        .query(
          `INSERT INTO direction_selections (
            id, project_id, round_id, comparison_direction_id, direction_key,
            title, rationale, position, payload, idempotency_key,
            request_fingerprint, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          projectId,
          roundId,
          value.comparisonDirectionId,
          value.directionKey,
          value.title,
          value.rationale,
          value.position,
          JSON.stringify(value.payload),
          value.idempotencyKey,
          requestFingerprint,
          now,
        );
    } catch (error) {
      const existing = this.database
        .query<
          { id: string; request_fingerprint: string },
          [string, string, string]
        >(
          `SELECT id, request_fingerprint FROM direction_selections
           WHERE project_id = ? AND round_id = ? AND idempotency_key = ?`,
        )
        .get(projectId, roundId, value.idempotencyKey);
      if (existing?.request_fingerprint === requestFingerprint) return existing;
      throw new StudioError(
        "STUDIO_CONFLICT",
        "Direction is already selected",
        {
          cause: error,
        },
      );
    }
    return { id };
  }

  createRefinement(input: unknown): StudioRound {
    const parsed = createRefinementSchema.safeParse(input);
    if (!parsed.success) {
      throw new StudioError(
        "STUDIO_INVALID_INPUT",
        "Refinement input is invalid",
        { cause: parsed.error },
      );
    }
    const value = parsed.data;
    const direction = this.database
      .query<{ id: string; title: string; position: number }, [string, string]>(
        `SELECT id, title, position FROM aesthetic_directions
         WHERE comparison_id = ? AND id = ?`,
      )
      .get(value.comparisonId, value.directionId);
    if (!direction) {
      throw new StudioError(
        "STUDIO_NOT_FOUND",
        "Comparison direction does not exist",
      );
    }
    const parents = this.database
      .query<{ id: string; project_id: string }, [string]>(
        `SELECT id, project_id FROM exploration_rounds
         WHERE comparison_id = ? AND stage = 'wide-net'
         ORDER BY id`,
      )
      .all(value.comparisonId);
    if (parents.length === 0) {
      throw new StudioError(
        "STUDIO_NOT_FOUND",
        "Wide-net round does not exist",
      );
    }
    if (parents.length !== 1) {
      throw new StudioError(
        "STUDIO_CONFLICT",
        "Comparison is linked to multiple wide-net rounds",
      );
    }
    const parent = parents[0];
    if (!parent) {
      throw new StudioError("STUDIO_DATA_INVALID", "Parent round is invalid");
    }

    const create = this.database.transaction(() => {
      const selection = this.createSelection(parent.project_id, parent.id, {
        directionKey: direction.id,
        comparisonDirectionId: direction.id,
        title: direction.title,
        rationale: "Chosen for refinement",
        position: direction.position,
        payload: {
          comparisonId: value.comparisonId,
          directionId: direction.id,
        },
        idempotencyKey: `${value.idempotencyKey}:selection`,
      });
      return this.createRound(parent.project_id, {
        stage: "refinement",
        prompt: `Create three refinements of ${direction.title}`,
        payload: {
          optionCount: 3,
          selectionId: selection.id,
          directionId: direction.id,
          options: [
            { position: 0, status: "placeholder" },
            { position: 1, status: "placeholder" },
            { position: 2, status: "placeholder" },
          ],
        },
        comparisonId: value.comparisonId,
        parentRoundId: parent.id,
        idempotencyKey: `${value.idempotencyKey}:round`,
      });
    });
    return create.immediate();
  }

  private message(row: MessageRow): StudioMessage {
    return {
      id: row.id,
      sessionId: row.session_id,
      runId: row.run_id,
      sequence: row.sequence,
      role: row.role,
      content: row.content,
      metadata: parseObject(row.metadata, "message metadata"),
      createdAt: row.created_at,
    };
  }

  hasCompletedRun(sessionIdInput: unknown): boolean {
    const sessionId = identifier.parse(sessionIdInput);
    return (
      this.database
        .query<{ id: string }, [string]>(
          "SELECT id FROM agent_runs WHERE session_id = ? AND status = 'completed' LIMIT 1",
        )
        .get(sessionId) !== null
    );
  }

  getSession(sessionIdInput: unknown): StudioSession {
    const sessionId = identifier.parse(sessionIdInput);
    const row = this.database
      .query<SessionRow, [string]>("SELECT * FROM agent_sessions WHERE id = ?")
      .get(sessionId);
    if (!row)
      throw new StudioError("STUDIO_NOT_FOUND", "Agent session does not exist");
    const messages = this.database
      .query<MessageRow, [string]>(
        "SELECT * FROM agent_messages WHERE session_id = ? ORDER BY sequence, id",
      )
      .all(sessionId)
      .map((message) => this.message(message));
    return {
      id: row.id,
      projectId: row.project_id,
      roundId: row.round_id,
      status: row.status,
      metadata: parseObject(row.metadata, "session metadata"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages,
    };
  }

  createSession(projectIdInput: unknown, input: unknown): StudioSession {
    const projectId = identifier.parse(projectIdInput);
    const parsed = createSessionSchema.safeParse(input);
    if (!parsed.success) {
      throw new StudioError(
        "STUDIO_INVALID_INPUT",
        "Session input is invalid",
        {
          cause: parsed.error,
        },
      );
    }
    this.requireProject(projectId);
    if (parsed.data.roundId) {
      const round = this.database
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM exploration_rounds WHERE project_id = ? AND id = ?",
        )
        .get(projectId, parsed.data.roundId);
      if (!round)
        throw new StudioError("STUDIO_NOT_FOUND", "Round does not exist");
    }
    const requestFingerprint = fingerprint({ projectId, ...parsed.data });
    const existing = this.database
      .query<SessionRow & { request_fingerprint: string }, [string, string]>(
        "SELECT * FROM agent_sessions WHERE project_id = ? AND idempotency_key = ?",
      )
      .get(projectId, parsed.data.idempotencyKey);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw new StudioError(
          "STUDIO_CONFLICT",
          "Session idempotency key was used for different input",
        );
      }
      return this.getSession(existing.id);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database
      .query(
        `INSERT INTO agent_sessions (
          id, project_id, round_id, status, metadata, idempotency_key,
          request_fingerprint, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'open', ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        projectId,
        parsed.data.roundId,
        JSON.stringify(parsed.data.metadata),
        parsed.data.idempotencyKey,
        requestFingerprint,
        now,
        now,
      );
    return this.getSession(id);
  }

  startRun(
    sessionIdInput: unknown,
    prompt: string,
  ): { runId: string; sequence: number } {
    const session = this.getSession(sessionIdInput);
    const sequence =
      (this.database
        .query<{ value: number | null }, [string]>(
          "SELECT MAX(sequence) AS value FROM agent_runs WHERE session_id = ?",
        )
        .get(session.id)?.value ?? 0) + 1;
    const runId = randomUUID();
    const now = new Date().toISOString();
    this.database
      .query(
        `INSERT INTO agent_runs (
          id, project_id, session_id, sequence, status, input, output, error,
          idempotency_key, request_fingerprint, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL, ?, ?, 1, ?, ?)`,
      )
      .run(
        runId,
        session.projectId,
        session.id,
        sequence,
        JSON.stringify({ prompt }),
        `run-${runId}`,
        fingerprint({ prompt }),
        now,
        now,
      );
    this.appendMessage(session.id, runId, "user", prompt, {});
    return { runId, sequence };
  }

  finishRun(
    sessionId: string,
    runId: string,
    result: { text?: string; error?: string; cancelled?: boolean },
  ): StudioSession {
    const session = this.getSession(sessionId);
    const now = new Date().toISOString();
    const status = result.cancelled
      ? "cancelled"
      : result.error
        ? "failed"
        : "completed";
    this.database
      .query(
        `UPDATE agent_runs
         SET status = ?, output = ?, error = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND session_id = ?`,
      )
      .run(
        status,
        result.text ? JSON.stringify({ text: result.text }) : null,
        result.error ?? null,
        now,
        runId,
        sessionId,
      );
    if (result.text) {
      this.appendMessage(sessionId, runId, "assistant", result.text, {});
    }
    this.database
      .query("UPDATE agent_sessions SET updated_at = ? WHERE id = ?")
      .run(now, session.id);
    return this.getSession(sessionId);
  }

  private appendMessage(
    sessionId: string,
    runId: string | null,
    role: StudioMessage["role"],
    content: string,
    metadata: Record<string, unknown>,
  ): void {
    const session = this.getSession(sessionId);
    const sequence =
      (this.database
        .query<{ value: number | null }, [string]>(
          "SELECT MAX(sequence) AS value FROM agent_messages WHERE session_id = ?",
        )
        .get(sessionId)?.value ?? 0) + 1;
    this.database
      .query(
        `INSERT INTO agent_messages (
          id, project_id, session_id, run_id, sequence, role, content, metadata,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        session.projectId,
        sessionId,
        runId,
        sequence,
        role,
        content,
        JSON.stringify(metadata),
        new Date().toISOString(),
      );
  }
}

import { useState, type FormEvent } from "react";
import type { DesignBrief, Inspiration } from "../library/types";
import type { StudioRepository } from "./repository";
import type { StudioProject, StudioRound, StudioSession } from "./types";

function referenceInput(reference: Inspiration) {
  return {
    title: reference.title,
    sourceUrl: reference.sourceUrl,
    aestheticFamily: reference.aestheticFamily,
    vocabulary: [...reference.vocabulary],
    observed: [
      reference.purpose,
      reference.composition,
      reference.typography,
      reference.colorMaterial,
      reference.motion,
      reference.borrow ? `Borrow: ${reference.borrow}` : "",
      reference.avoid ? `Avoid: ${reference.avoid}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    limitation: reference.limitation,
    assetPaths: reference.assets.map((asset) => asset.url),
  };
}

export function AgentPanel({
  repository,
  project,
  round,
  brief,
  references,
  session,
  onSession,
}: {
  readonly repository: StudioRepository;
  readonly project: StudioProject;
  readonly round?: StudioRound;
  readonly brief?: DesignBrief;
  readonly references: readonly Inspiration[];
  readonly session: StudioSession | null;
  readonly onSession: (session: StudioSession) => void;
}) {
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"review" | "build">("review");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = message.trim();
    if (!prompt || sending) return;
    setSending(true);
    setError("");
    try {
      const activeSession =
        session ??
        (await repository.createSession(project.id, round?.id ?? null));
      if (!session) onSession(activeSession);
      setMessage("");
      const updated = await repository.sendMessage(activeSession.id, {
        message: prompt,
        mode,
        brief: brief?.markdown ?? "",
        round: round?.prompt ?? "",
        phase: round?.stage ?? "discussion",
        references: references.map(referenceInput),
        tweaks: {},
      });
      onSession(updated);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Local agent request failed",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="agent-panel" aria-labelledby="agent-panel-title">
      <header>
        <div>
          <p className="studio-kicker">Local Claude Code</p>
          <h2 id="agent-panel-title">Discuss the evidence</h2>
        </div>
        <label>
          Mode
          <select
            value={mode}
            onChange={(event) =>
              setMode(event.currentTarget.value as "review" | "build")
            }
          >
            <option value="review">Review only</option>
            <option value="build">Build in workbench copy</option>
          </select>
        </label>
      </header>
      <p className="agent-context-summary">
        {references.length} selected{" "}
        {references.length === 1 ? "reference" : "references"}
        {brief ? ` · ${brief.title}` : " · no brief selected"}
        {round ? ` · ${round.stage} round ${round.sequence}` : ""}
      </p>
      <div className="agent-transcript" aria-live="polite">
        {session?.messages.length ? (
          session.messages.map((item) => (
            <article key={item.id} data-role={item.role}>
              <p>{item.role === "assistant" ? "Agent" : "You"}</p>
              <div>{item.content}</div>
            </article>
          ))
        ) : (
          <div className="agent-empty">
            Ask what the selected examples share, which qualities fit this site,
            or how to turn them into five distinct directions.
          </div>
        )}
        {sending ? <p role="status">Local agent is working…</p> : null}
      </div>
      <form onSubmit={submit}>
        {error ? (
          <p className="studio-error" role="alert">
            {error}
          </p>
        ) : null}
        <label>
          Message
          <textarea
            rows={4}
            value={message}
            onChange={(event) => setMessage(event.currentTarget.value)}
            placeholder="Compare these references and tell me what belongs in this site's brief."
          />
        </label>
        <button type="submit" disabled={sending || !message.trim()}>
          {sending ? "Running local agent…" : "Send to local agent"}
        </button>
      </form>
    </section>
  );
}

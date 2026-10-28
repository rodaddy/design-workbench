# Agent Chat

The approved Studio direction includes persistent conversation with a local
coding agent. This document defines that target and the current manual boundary.

## Current state

**Persistence schema groundwork exists; operational chat is planned.**

The Design Workbench web application does not start an agent, expose a chat
drawer, persist agent sessions, stream run events, cancel a run, or resume a
local CLI session. It stores no model credentials.

The Studio migration reserves tables for agent sessions, runs, and messages.
There is no session store, API, process runner, event stream, cancellation
handler, resume path, or UI using those tables. Schema presence is not a
working chat feature.

For now, discuss Library references and briefs in an external installed-agent
session. Copy only the distilled decisions into the canonical brief or
comparison metadata.

## Initial provider boundary

The approved first provider is the installed local Claude Code CLI. The planned
runner uses the local executable and existing CLI authentication; it does not
use the Claude web app, a browser integration, or stored API keys. Codex or
another provider may be added behind the same internal boundary later, but is
not part of the first delivery.

The planned invocation uses `Bun.spawn` with an argv array and explicit
`--print`, `--output-format stream-json`, session-id/resume, `--no-chrome`,
model, effort, tool, permission, working-directory, and timeout arguments.
Those flags describe the target contract only; no current application path
launches them.

## Planned modes

### Discuss

Read-only by default. The agent may inspect the context packet and answer
questions about selected references, shared qualities, trade-offs, and fit for
the project. It must distinguish observed local evidence from recommendation
and cite selected reference titles.

### Review

Read-only evaluation of a baseline or generated proof against the brief,
`Always`/`Never` guardrails, accessibility constraints, and current selection
history.

### Build

Explicitly invoked and write-scoped only to a workbench-owned copied snapshot or
assigned generated-artifact directory. Build mode never writes to the canonical
local source site.

## Planned context packet

Each run receives a bounded, inspectable packet containing only relevant local
material:

- selected Library records, titles, provenance, limitations, vocabulary, and
  local evidence assets;
- the allowlisted project baseline snapshot and entry page;
- the canonical four-part brief;
- the current comparison round and direction;
- the selected proof, refinement, or asset when one exists;
- the current tweak snapshot when tuning has begun.

The packet must not silently add unrelated repository content, credentials, raw
environment values, or production-only material.

## Permission and process contract

The planned runner must:

- invoke the installed local CLI with an argv array, never interpolated shell
  text;
- reuse local CLI authentication without reading or storing credential values;
- pin the allowed model, effort, tools, permission mode, working directory, and
  timeout;
- allow one active run per session;
- persist session ID, sanitized messages, timestamps, state, exit status, and
  bounded error details;
- stream same-origin run events and expose explicit cancellation;
- resume only the selected persisted session;
- fail visibly when the executable, session, artifact root, or context packet is
  invalid.

Cancellation means the run stopped; it does not mean partial output is valid.
Resume means continue the same recorded session; it does not mean reconstruct
missing history from guesses.

## Secrets and trust

- No API keys, tokens, credential values, or env-file contents enter messages,
  SQLite records, logs, artifacts, or prompts.
- The trusted application may coordinate the local process. Generated pages
  remain untrusted and cannot call the agent API.
- A chat recommendation cannot mutate source, register an artifact, select a
  winner, or deploy anything without the corresponding explicit operator
  action.

Until this runner exists, any claim that the in-app agent discussed, generated,
cancelled, resumed, or applied a change is false.

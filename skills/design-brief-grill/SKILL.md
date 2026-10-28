---
name: design-brief-grill
description: "Interactive design-brief grilling for requests such as 'grill me on the design', 'grill my brief', 'interrogate my design idea', 'turn this idea into a design brief', 'help me define the aesthetic', or 'sharpen my frontend prompt'. Use it to challenge vague visual direction, define references and intent, set design guardrails, and produce a copy-ready prompt for Impeccable or Taste Skill."
---

# Design Brief Grill

Turn an early design idea into a concrete, reusable brief through a focused,
adversarial interview. This is a capability-uplift skill: it improves the
quality of the decisions before any page or aesthetic is generated.

## Use This Skill

Trigger when the user asks to:

- grill or interrogate a design idea or brief;
- turn an idea into an actionable design brief;
- define or sharpen an aesthetic or visual direction;
- improve a frontend generation prompt;
- convert references, intent, and constraints into design guardrails.

Do not trigger for a direct implementation request that already includes a
complete, concrete brief unless the user asks for critique or refinement.

## Canonical Procedure

Read and follow [`_DOCS/procedure.md`](_DOCS/procedure.md) completely before
starting the interview.

The procedure owns the question discipline, required sections, adversarial
completeness pass, completion gate, and final Markdown artifact.

## Runtime Adapters

Runtime-specific skill files are discovery adapters only. They must point to
this project-owned skill and must not duplicate its procedure.

## Fallback

If the procedure cannot be loaded, stop and report the missing project file.
Do not improvise a shortened interview or generate a design prematurely.

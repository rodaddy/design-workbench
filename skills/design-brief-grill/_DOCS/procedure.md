# Design Brief Grill Procedure

## Outcome

Produce a concrete design brief that another design-capable agent can act on
without guessing. The finished artifact must work as input to either Impeccable
or Taste Skill and must include a copy-ready generation prompt for multiple
distinct variants.

## Interview Discipline

- Ask exactly one focused question at a time.
- Adapt the next question to the user's latest answer; do not dump a
  questionnaire.
- Push back immediately when an answer is vague, generic, contradictory, or
  non-observable.
- Ask for a decision, example, or trade-off instead of silently filling gaps.
- Do not generate a page, mockup, implementation, or final prompt during the
  interview.
- Do not prescribe an aesthetic before understanding the user's references,
  intent, audience, and constraints.
- Summarize distilled decisions when useful, but do not store or output the raw
  interview transcript unless the user explicitly asks for it.

Move between sections as answers develop, but do not complete the interview
until every required section passes its concrete-enough gate.

## Required Sections

### 1. Aesthetic Family And Visual Vocabulary

Establish one primary aesthetic family. A secondary influence is allowed only
when the relationship between the two is explicit.

Collect 5-8 precise visual vocabulary terms. Each term must describe something
observable in the result, such as:

- composition or spatial behavior;
- typography treatment;
- color, contrast, texture, or material;
- shape language, borders, depth, or imagery;
- interaction or motion character.

Reject standalone labels such as `modern`, `clean`, `sleek`, `premium`, or
`beautiful`. They are acceptable only after conversion into observable
properties.

Concrete-enough gate:

- the aesthetic family has a recognizable design lineage or visual logic;
- 5-8 terms are specific enough that two designers would interpret them
  similarly;
- generic adjectives have been translated into visible properties;
- any mixed influences have a stated hierarchy rather than an unresolved blend.

### 2. References And Borrowed Qualities

Ask for screenshots, saved library items, or URLs. For every reference, identify
exactly what to borrow:

- feeling or emotional tone;
- composition or information hierarchy;
- typography;
- interaction or motion;
- color, texture, imagery, or another specific quality.

Also identify what must not be borrowed. Never ask to copy a reference's
content, brand identity, proprietary assets, or distinctive composition
wholesale. References are evidence for qualities, not cloning targets.

If the user has no reference, ask for a concrete analog, counterexample, or
search direction. Do not invent a reference on their behalf.

Concrete-enough gate:

- at least one useful reference or explicit analog is present;
- every reference has named borrowed qualities;
- copying boundaries are explicit;
- conflicting reference qualities have been reconciled or prioritized.

### 3. Intent

Determine:

- what is being built;
- who the audience is;
- what the audience should feel;
- the single primary user action;
- why that action and feeling matter.

Separate business intent from visual preference. If multiple primary actions
are proposed, force a priority and classify the rest as secondary.

Concrete-enough gate:

- the artifact or experience is named;
- the audience is more specific than “everyone” or “customers”;
- the desired feeling is connected to the context;
- one primary action is unambiguous;
- the reason links the design to a user or business outcome.

### 4. Guardrails

Collect explicit `Always` constants and `Never` bans. Guardrails must be
testable, not aspirational.

Cover when relevant:

- brand, content, information hierarchy, and interaction constants;
- accessibility requirements such as contrast, focus visibility, reduced
  motion, semantic structure, keyboard use, and readable type;
- responsive behavior and priority changes across screen sizes;
- technical, content, performance, or asset constraints;
- visual or interaction clichés to avoid.

Concrete-enough gate:

- `Always` contains the invariants that every variant must preserve;
- `Never` contains explicit banned patterns or failure modes;
- accessibility and responsiveness are addressed or marked not relevant with a
  reason;
- no guardrail contradicts the intent or required content.

## Follow-Up Challenges

Use these as patterns, not as a script:

| Weak answer | Follow-up challenge |
| --- | --- |
| “Make it modern and clean.” | “What would I literally see that makes it modern and clean: type scale, spacing density, borders, color contrast, imagery, or motion? Choose the three most important observable properties.” |
| “It should feel premium.” | “Premium can mean restrained editorial space, polished material depth, or high-touch ornament. Which interpretation fits, and what visible choices prove it?” |
| “Like Apple.” | “Which specific quality are you borrowing—product isolation, typography restraint, cinematic transitions, or information pacing—and what Apple brand/content elements must remain off-limits?” |
| “The audience is everyone.” | “Who must understand and act on this first? Name their context, level of familiarity, and what they arrive needing.” |
| “The main goals are sign up, explore, and learn.” | “If the design can make only one action unmistakable, which action wins? The others can become secondary.” |
| “Make it bold but minimal.” | “Where should boldness appear, and where must restraint win? Define the hierarchy so those directions do not cancel each other out.” |
| “Use lots of animation, but it must be fast and accessible.” | “Which moments earn motion, what duration or behavior is acceptable, and what happens under reduced-motion settings?” |
| “It needs to work on mobile.” | “What content and action must remain above the fold on a narrow screen, and what may collapse, reorder, or disappear?” |

## Adversarial Completeness Pass

After all four sections appear complete, perform a short challenge pass. Present
one issue at a time and ask for a decision when needed.

Check for:

1. contradictions between desired feeling, visual vocabulary, references,
   intent, and guardrails;
2. missing decisions that would force an implementer to guess;
3. clichés or generic patterns presented as direction;
4. infeasible combinations involving scope, content, assets, performance,
   accessibility, responsiveness, or motion;
5. references whose borrowed qualities conflict with each other or with the
   intended audience and action.

Do not soften a real conflict into an “open question.” Resolve it with the user
before finishing. A known execution risk may remain only when its impact and
mitigation are explicit; an undecided design direction may not.

## Completion Gate

End only when:

- all four required sections pass their concrete-enough gates;
- the adversarial pass has no unresolved contradiction or missing decision;
- the visual vocabulary contains 5-8 precise terms;
- references state both borrowed qualities and copying boundaries;
- there is one primary user action;
- `Always` and `Never` are explicit and testable;
- any remaining open risk has an impact and mitigation;
- the final generation prompt can stand alone without the interview transcript.

If a gate fails, continue asking one focused question at a time.

## Final Artifact

Output only the distilled Markdown brief unless the user asks for the raw
interview. Fill every field; do not leave placeholder text in the delivered
artifact.

```markdown
# [Brief title]

## Aesthetic family
[Primary family and any explicitly subordinated influence]

## Visual vocabulary
- [5-8 observable terms, each clarified where needed]

## References and borrowed qualities
- **[Reference name or URL]:** Borrow [specific feeling, composition,
  typography, motion, color, texture, or imagery quality]. Do not copy
  [content, brand identity, proprietary assets, or distinctive composition].

## Intent
[What is being built, the desired feeling, and why it matters]

## Audience
[Specific audience, context, and relevant familiarity]

## Primary action
[One primary action and any clearly subordinate actions]

## Always
- [Testable constants every variant must preserve]

## Never
- [Explicit bans and failure modes]

## Open risks
- **[Risk]:** Impact: [impact]. Mitigation: [mitigation].
- None, if the adversarial pass found no remaining execution risks.

## Final copy-ready generation prompt
Create at least three genuinely distinct design variants for [what is being
built] using the following brief. The variants must explore meaningfully
different compositions, typographic systems, or interaction approaches while
preserving the same intent, primary action, Always constants, Never bans,
accessibility requirements, and responsive priorities.

Aesthetic family: [family].
Visual vocabulary: [5-8 terms].
Audience: [audience].
Desired feeling and why: [feeling and rationale].
Primary action: [action].
References and qualities to borrow: [reference-quality mappings].
Always: [constants].
Never: [bans].
Open risks and mitigations: [risks].

Use the references only as evidence for abstract qualities. Do not directly
copy their content, brand identity, proprietary assets, or distinctive
composition. Make each variant coherent rather than mixing every influence
together. For each variant, briefly state its design thesis and the key
trade-off it makes.
```

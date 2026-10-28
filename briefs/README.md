# Canonical Design Briefs

Store reusable distilled briefs in this directory. The interview behavior and
completion gate remain owned by
`skills/design-brief-grill/_DOCS/procedure.md`; this file documents only the
artifact consumed by the application and CLIs.

Each Markdown file must use exactly this heading order:

```text
# Brief title
## Aesthetic family
## Visual vocabulary
## References and borrowed qualities
## Intent
## Audience
## Primary action
## Always
## Never
## Open risks
## Final copy-ready generation prompt
```

`Visual vocabulary` must contain 5-8 `- ` bullet items. References, Always,
Never, and Open risks must each contain at least one `- ` bullet item. All
other sections require non-empty text. Extra, missing, duplicate, or reordered
sections fail validation.

Import through the trusted API or create a comparison directly:

```sh
bun run comparison:new --brief briefs/<name>.md --directions <1-5>
```

The comparison CLI validates the brief before creating database rows or
artifact directories and exits nonzero with structured JSON on invalid input.

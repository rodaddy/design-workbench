import { z } from "zod";

const REQUIRED_SECTIONS = [
  "Aesthetic family",
  "Visual vocabulary",
  "References and borrowed qualities",
  "Intent",
  "Audience",
  "Primary action",
  "Always",
  "Never",
  "Open risks",
  "Final copy-ready generation prompt",
] as const;

const nonEmptyText = z.string().trim().min(1, "must not be empty");
const nonEmptyList = z
  .array(nonEmptyText)
  .min(1, "must contain at least one item");

export const designBriefSchema = z
  .object({
    title: nonEmptyText,
    aestheticFamily: nonEmptyText,
    visualVocabulary: z
      .array(nonEmptyText)
      .min(5, "must contain at least 5 items")
      .max(8, "must contain at most 8 items"),
    referencesAndBorrowedQualities: nonEmptyList,
    intent: nonEmptyText,
    audience: nonEmptyText,
    primaryAction: nonEmptyText,
    always: nonEmptyList,
    never: nonEmptyList,
    openRisks: nonEmptyList,
    finalCopyReadyGenerationPrompt: nonEmptyText,
  })
  .strict();

export type DesignBrief = z.infer<typeof designBriefSchema>;

export type DesignBriefIssue = {
  code:
    | "duplicate_section"
    | "invalid_format"
    | "invalid_value"
    | "missing_section"
    | "unexpected_section";
  path: string;
  message: string;
};

export class DesignBriefValidationError extends Error {
  readonly code = "INVALID_DESIGN_BRIEF";
  readonly issues: readonly DesignBriefIssue[];

  constructor(issues: readonly DesignBriefIssue[]) {
    super("Design brief validation failed");
    this.name = "DesignBriefValidationError";
    this.issues = issues;
  }
}

function fail(issue: DesignBriefIssue): never {
  throw new DesignBriefValidationError([issue]);
}

function sectionPath(heading: string): string {
  const paths: Record<(typeof REQUIRED_SECTIONS)[number], keyof DesignBrief> = {
    "Aesthetic family": "aestheticFamily",
    "Visual vocabulary": "visualVocabulary",
    "References and borrowed qualities": "referencesAndBorrowedQualities",
    Intent: "intent",
    Audience: "audience",
    "Primary action": "primaryAction",
    Always: "always",
    Never: "never",
    "Open risks": "openRisks",
    "Final copy-ready generation prompt": "finalCopyReadyGenerationPrompt",
  };

  return heading in paths
    ? paths[heading as (typeof REQUIRED_SECTIONS)[number]]
    : heading;
}

function parseBulletList(content: string, path: string): string[] {
  const lines = content.split("\n");
  const items: string[] = [];
  let current = "";

  for (const line of lines) {
    const bullet = /^- (.+)$/.exec(line);
    if (bullet) {
      if (current) items.push(current);
      current = bullet[1].trim();
      continue;
    }

    if (/^\s{2,}\S/.test(line) && current) {
      current += ` ${line.trim()}`;
      continue;
    }

    fail({
      code: "invalid_format",
      path,
      message: "must be a Markdown bullet list using '- '",
    });
  }

  if (current) items.push(current);
  return items;
}

function zodIssues(error: z.ZodError): DesignBriefIssue[] {
  return error.issues.map((issue) => ({
    code: "invalid_value",
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export function parseDesignBrief(input: unknown): DesignBrief {
  if (typeof input !== "string") {
    fail({
      code: "invalid_format",
      path: "",
      message: "design brief must be a Markdown string",
    });
  }

  const markdown = input.replace(/\r\n?/g, "\n").trim();
  const titleMatch = /^# ([^\n]+)\n+/.exec(markdown);
  if (!titleMatch) {
    fail({
      code: "missing_section",
      path: "title",
      message: "must begin with exactly one '# ' title",
    });
  }

  const title = titleMatch[1].trim();
  const body = markdown.slice(titleMatch[0].length);
  if (/^# .+$/m.test(body)) {
    fail({
      code: "duplicate_section",
      path: "title",
      message: "duplicate section: title",
    });
  }
  const headingPattern = /^## (.+)$/gm;
  const headings = [...body.matchAll(headingPattern)];

  const seen = new Set<string>();
  for (const heading of headings) {
    const name = heading[1].trim();
    if (seen.has(name)) {
      fail({
        code: "duplicate_section",
        path: sectionPath(name),
        message: `duplicate section: ${name}`,
      });
    }
    seen.add(name);
  }

  for (const required of REQUIRED_SECTIONS) {
    if (!seen.has(required)) {
      fail({
        code: "missing_section",
        path: sectionPath(required),
        message: `missing section: ${required}`,
      });
    }
  }

  const actualHeadings = headings.map((heading) => heading[1].trim());
  const unexpected = actualHeadings.find(
    (heading) =>
      !REQUIRED_SECTIONS.includes(
        heading as (typeof REQUIRED_SECTIONS)[number],
      ),
  );
  if (unexpected) {
    fail({
      code: "unexpected_section",
      path: unexpected,
      message: `unexpected section: ${unexpected}`,
    });
  }

  if (
    actualHeadings.length !== REQUIRED_SECTIONS.length ||
    actualHeadings.some(
      (heading, index) => heading !== REQUIRED_SECTIONS[index],
    )
  ) {
    fail({
      code: "invalid_format",
      path: "",
      message: "sections must appear in canonical order",
    });
  }

  const sections = new Map<string, string>();
  headings.forEach((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? body.length;
    const content = body.slice(start, end).trim();
    sections.set(heading[1].trim(), content);
  });

  const value = {
    title,
    aestheticFamily: sections.get("Aesthetic family") ?? "",
    visualVocabulary: parseBulletList(
      sections.get("Visual vocabulary") ?? "",
      "visualVocabulary",
    ),
    referencesAndBorrowedQualities: parseBulletList(
      sections.get("References and borrowed qualities") ?? "",
      "referencesAndBorrowedQualities",
    ),
    intent: sections.get("Intent") ?? "",
    audience: sections.get("Audience") ?? "",
    primaryAction: sections.get("Primary action") ?? "",
    always: parseBulletList(sections.get("Always") ?? "", "always"),
    never: parseBulletList(sections.get("Never") ?? "", "never"),
    openRisks: parseBulletList(sections.get("Open risks") ?? "", "openRisks"),
    finalCopyReadyGenerationPrompt:
      sections.get("Final copy-ready generation prompt") ?? "",
  };

  const result = designBriefSchema.safeParse(value);
  if (!result.success) {
    throw new DesignBriefValidationError(zodIssues(result.error));
  }
  return result.data;
}

function renderList(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

export function serializeDesignBrief(input: unknown): string {
  const result = designBriefSchema.safeParse(input);
  if (!result.success) {
    throw new DesignBriefValidationError(zodIssues(result.error));
  }

  const brief = result.data;
  return `# ${brief.title}

## Aesthetic family
${brief.aestheticFamily}

## Visual vocabulary
${renderList(brief.visualVocabulary)}

## References and borrowed qualities
${renderList(brief.referencesAndBorrowedQualities)}

## Intent
${brief.intent}

## Audience
${brief.audience}

## Primary action
${brief.primaryAction}

## Always
${renderList(brief.always)}

## Never
${renderList(brief.never)}

## Open risks
${renderList(brief.openRisks)}

## Final copy-ready generation prompt
${brief.finalCopyReadyGenerationPrompt}
`;
}

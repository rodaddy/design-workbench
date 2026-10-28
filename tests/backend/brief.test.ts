import { describe, expect, test } from "bun:test";
import {
  DesignBriefValidationError,
  parseDesignBrief,
  serializeDesignBrief,
  type DesignBrief,
} from "../../src/shared/brief";

const BRIEF: DesignBrief = {
  title: "Quiet portfolio",
  aestheticFamily: "Swiss editorial with a subordinate cinematic influence.",
  visualVocabulary: [
    "Asymmetric twelve-column composition",
    "High-contrast grotesk display type",
    "Warm off-white paper texture",
    "Hairline graphite dividers",
    "Desaturated cobalt accents",
  ],
  referencesAndBorrowedQualities: [
    "**Museum catalogue:** Borrow measured pacing and typographic hierarchy. Do not copy content, identity, assets, or composition.",
  ],
  intent:
    "Build a portfolio that feels deliberate and calm so senior design leads can assess the work without distraction.",
  audience:
    "Senior design leads reviewing product designers on desktop and mobile.",
  primaryAction: "Open a case study; contacting the designer is secondary.",
  always: [
    "Keep the case-study action visible above the fold.",
    "Provide visible keyboard focus and reduced-motion behavior.",
  ],
  never: [
    "Never use auto-playing video.",
    "Never hide navigation behind hover-only interaction.",
  ],
  openRisks: [
    "**Image availability:** Impact: sparse projects may feel unfinished. Mitigation: use consistent text-led project covers.",
  ],
  finalCopyReadyGenerationPrompt:
    "Create at least three distinct portfolio variants that preserve the audience, intent, primary action, accessibility requirements, and responsive priorities.",
};

function expectIssue(
  action: () => unknown,
  expected: { code: string; path: string },
): void {
  try {
    action();
    throw new Error("Expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DesignBriefValidationError);
    const validationError = error as DesignBriefValidationError;
    expect(validationError.code).toBe("INVALID_DESIGN_BRIEF");
    expect(validationError.issues[0]).toMatchObject(expected);
  }
}

describe("design brief Markdown codec", () => {
  test("serializes canonical sections and round-trips caller-visible data", () => {
    const markdown = serializeDesignBrief(BRIEF);

    expect(markdown).toStartWith("# Quiet portfolio\n\n## Aesthetic family\n");
    expect(markdown).toContain(
      "\n## Final copy-ready generation prompt\nCreate at least three",
    );
    expect(parseDesignBrief(markdown)).toEqual(BRIEF);
  });

  test("accepts wrapped continuation lines in canonical bullet sections", () => {
    const markdown = serializeDesignBrief(BRIEF).replace(
      "Borrow measured pacing and typographic hierarchy. Do not copy",
      "Borrow measured pacing and typographic hierarchy.\n  Do not copy",
    );

    expect(parseDesignBrief(markdown).referencesAndBorrowedQualities[0]).toBe(
      BRIEF.referencesAndBorrowedQualities[0],
    );
  });

  test("rejects a missing required section with stable structured details", () => {
    const markdown = serializeDesignBrief(BRIEF).replace(
      /\n## Audience\n.*?(?=\n## Primary action)/s,
      "",
    );

    expectIssue(() => parseDesignBrief(markdown), {
      code: "missing_section",
      path: "audience",
    });
  });

  test("rejects duplicate canonical sections", () => {
    const markdown = serializeDesignBrief(BRIEF).replace(
      "## Intent\n",
      "## Intent\nFirst intent.\n\n## Intent\n",
    );

    expectIssue(() => parseDesignBrief(markdown), {
      code: "duplicate_section",
      path: "intent",
    });
  });

  test("rejects a duplicate title", () => {
    const markdown = serializeDesignBrief(BRIEF).replace(
      "## Aesthetic family",
      "# Second title\n\n## Aesthetic family",
    );

    expectIssue(() => parseDesignBrief(markdown), {
      code: "duplicate_section",
      path: "title",
    });
  });

  test("rejects malformed list content", () => {
    const markdown = serializeDesignBrief(BRIEF).replace(
      "- Asymmetric twelve-column composition",
      "Asymmetric twelve-column composition",
    );

    expectIssue(() => parseDesignBrief(markdown), {
      code: "invalid_format",
      path: "visualVocabulary",
    });
  });

  test.each([
    {
      name: "fewer than five vocabulary terms",
      vocabulary: BRIEF.visualVocabulary.slice(0, 4),
      message: "must contain at least 5 items",
    },
    {
      name: "more than eight vocabulary terms",
      vocabulary: [
        ...BRIEF.visualVocabulary,
        "Editorial image crops",
        "Measured reveal motion",
        "Dense caption rhythm",
        "Monospaced metadata labels",
      ],
      message: "must contain at most 8 items",
    },
  ])("rejects $name", ({ vocabulary, message }) => {
    expectIssue(
      () => serializeDesignBrief({ ...BRIEF, visualVocabulary: vocabulary }),
      { code: "invalid_value", path: "visualVocabulary" },
    );

    try {
      serializeDesignBrief({ ...BRIEF, visualVocabulary: vocabulary });
    } catch (error) {
      expect((error as DesignBriefValidationError).issues[0]?.message).toBe(
        message,
      );
    }
  });

  test("rejects non-string parser input at the trust boundary", () => {
    expectIssue(() => parseDesignBrief({ markdown: "not trusted" }), {
      code: "invalid_format",
      path: "",
    });
  });

  test("rejects unknown serializer fields", () => {
    expectIssue(() => serializeDesignBrief({ ...BRIEF, extra: true }), {
      code: "invalid_value",
      path: "",
    });
  });
});

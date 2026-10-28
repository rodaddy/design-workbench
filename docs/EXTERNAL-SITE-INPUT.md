# External Site Input

External sites enter Design Workbench as bounded reference evidence, not as
trusted source trees and not as automatically captured production dependencies.

## Current input path

**Implemented manually.**

Create or edit a Library record with:

- the original public URL;
- a title and category;
- evidence status and exact limitation text;
- operator-supplied screenshot or media when authorized;
- observable design analysis, vocabulary, image prompt, and reusable brief
  notes.

Uploads are stored locally through the trusted application boundary. The
original URL remains provenance; it does not make the live page available to
comparison generation.

## Automated capture

**Deferred; not implemented.**

The application, import scripts, tests, builds, and detector scans do not open a
browser or crawl an external site. A URL without operator-supplied evidence is
not a captured reference.

The tracked Taste Board intentionally preserves captured, partial, and blocked
records. Do not upgrade `partial` or `blocked` to `captured` because a title,
thumbnail, embed, or URL is present.

## Operator procedure

1. Confirm the page is public and that collecting the intended evidence is
   authorized.
2. Record the exact source URL and observation date.
3. Supply only the screenshot or media needed to support the analysis.
4. Label what was observed and what remains unavailable.
5. Extract abstract qualities: feeling, composition, typography, color,
   texture, imagery, interaction, or motion.
6. Record what must not be copied.
7. Use those qualities in the four-part grill; do not use third-party content,
   identity, proprietary assets, testimonials, client proof, or distinctive
   composition as project material.

## Using external evidence in a glam-up

External evidence can inform a brief and its directions. It cannot become:

- a project baseline;
- an engine output;
- a claim that the live site was reproduced;
- permission to download additional assets;
- permission to contact, submit forms to, authenticate to, or deploy against
  the source.

For locally owned source, use the separate boundary in
[`LOCAL-SOURCE-SITES.md`](LOCAL-SOURCE-SITES.md). The planned Studio adapter
will snapshot allowlisted local files; it will not fetch the production URL.

## Future adapter boundary

A future browser-capture adapter may populate the same Library fields and local
asset store, but it must preserve source URL, observation time, capture status,
limitations, authorization, and failure receipts. Until that adapter ships and
is verified, all external-site input remains manual.

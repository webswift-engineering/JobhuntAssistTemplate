import { z } from "zod";
import type { LlmClient } from "./client.js";

/**
 * A field extraction spec, relative to a card element. At least one of
 * selector/attr/textLine/template is expected. Resolution order (client side):
 * template > textLine > (selector|card).attr, then optional regex capture group 1.
 */
export const FieldSpecSchema = z
  .object({
    selector: z.string().optional(),
    attr: z.string().optional(), // "text" (default) | "aria-label" | "href" | "componentkey" | ...
    regex: z.string().optional(),
    textLine: z.number().int().optional(),
    template: z.string().optional(), // e.g. "https://site/jobs/{id}"
  })
  .strict();

export const SiteAdapterSchema = z.object({
  cardSelector: z.string().min(1),
  fields: z.object({
    title: FieldSpecSchema.optional(),
    company: FieldSpecSchema.optional(),
    location: FieldSpecSchema.optional(),
    id: FieldSpecSchema.optional(),
    href: FieldSpecSchema.optional(),
  }),
  notes: z.string().optional(),
});

export type SiteAdapter = z.infer<typeof SiteAdapterSchema>;

const SYSTEM = [
  "You write extraction adapters for job-search RESULTS-LIST pages.",
  "Given a compressed DOM digest of the page, output STRICT JSON describing how to",
  "select each job card in the results list and how to read its fields.",
  "",
  "CRITICAL RULES:",
  "- Prefer STABLE selectors: attributes like componentkey, data-*, role, aria-label,",
  "  and element structure. NEVER rely on hashed/random class names (e.g. _69ebbc25, dec34939).",
  "- cardSelector must match the repeating job cards in the LEFT results list — NOT nav bars,",
  "  filters, ads, or the single job open in a detail pane. Pick the selector that matches many",
  "  sibling cards (the digest marks repeats as '(xN more ...)').",
  "- For each field, choose the most robust spec:",
  "    selector: a CSS selector RELATIVE to the card (omit to use the card element itself)",
  "    attr: 'text' (default, visible text) | 'aria-label' | 'href' | any attribute name",
  "    regex: capture group 1 is used (e.g. extract an id from an attribute value)",
  "    textLine: 0-based index into the card's visible text lines (title is usually 0,",
  "      company 1, location 2) — use this when there are no stable per-field selectors",
  "    template: build a value from the id, using '{id}', e.g. an href like",
  "      'https://www.example.com/jobs/view/{id}/'",
  "- Always provide title. Provide company, location, id, and href when derivable.",
  "- If the site identifies cards by an id embedded in an attribute (e.g. componentkey",
  "  'job-card-component-ref-123'), extract id via attr+regex and build href via template.",
  "",
  'Return JSON: { "cardSelector": string, "fields": { "title": FieldSpec, "company"?: FieldSpec,',
  '"location"?: FieldSpec, "id"?: FieldSpec, "href"?: FieldSpec }, "notes"?: string }',
  "where FieldSpec = { selector?, attr?, regex?, textLine?, template? }.",
].join("\n");

/** Ask the LLM to synthesize a stable extraction adapter from a page digest. */
export async function generateSiteAdapter(
  llm: LlmClient,
  host: string,
  digest: string
): Promise<SiteAdapter> {
  return llm.completeJson(
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          `HOST: ${host}`,
          "",
          "COMPRESSED DOM DIGEST:",
          digest.slice(0, 24000),
        ].join("\n"),
      },
    ],
    SiteAdapterSchema
  );
}

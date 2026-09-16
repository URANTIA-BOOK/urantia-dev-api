# Plan: Multi-Language Support for Urantia Papers API

## Official language trees first

Foundation editions already exist as pipeline language repos (`make langs-run`
in [URANTIA-BOOK/pipeline](https://github.com/URANTIA-BOOK/pipeline)). Those
companions are the source of truth for published book text. AI-generated
overlays in `data/translations/` must not replace an official edition.

Seed English (and, once `globalId` is unique per language, other official
trees) from `BOOK_TREE`. Use AI translation only for languages the Foundation
has not published.

## Context

The API currently serves only English content. We want to add multi-language support. Official translations come from the pipeline language trees. For languages without a Foundation edition, generate AI overlays from the English source text. The urantiapedia repo has existing translations but we can't use them (copyright).

**Priority languages (top 5 by Urantia Book readership):** Spanish (es), French (fr), Portuguese (pt), German (de), Korean (ko)

**API design:** `?lang=` query parameter on all endpoints. Default to `en` when omitted — fully backwards compatible.

## Two-Part Project

**Part A: API multi-language support** — DB schema changes, route updates, seed script updates
**Part B: Translation generation script** — AI-translate all ~14,500 paragraphs into 5 languages

Part A ships first (with just English data), then Part B populates additional languages.

---

## Part A: API Multi-Language Support

### Files to Modify

| File | Changes |
|------|---------|
| `src/db/schema.ts` | Add `language` to parts/papers/sections tables. Change paragraph unique constraints to be per-language. Add language index. |
| `src/validators/schemas.ts` | Add `lang` query param schema. Add `language` field back to ParagraphSchema. Add to Paper/Part/Section schemas. |
| `src/routes/toc.ts` | Accept `?lang=`, filter parts/papers by language |
| `src/routes/papers.ts` | Accept `?lang=`, filter papers/paragraphs/sections by language |
| `src/routes/paragraphs.ts` | Accept `?lang=`, filter by language in all queries |
| `src/routes/search.ts` | Accept `lang` in body, filter by language, parameterize FTS language config |
| `src/routes/audio.ts` | Accept `?lang=`, filter by language (audio may be null for non-English) |
| `scripts/seed.ts` | Accept language parameter, support seeding translated content |
| `scripts/setup-fts.sql` | Update to support language-specific text search configs |

### Step A1: Database Schema Changes

**`src/db/schema.ts`:**

Add `language` column to all 4 tables:
```typescript
// parts
language: text("language").notNull().default("en"),

// papers
language: text("language").notNull().default("en"),

// sections
language: text("language").notNull().default("en"),

// paragraphs — already has language column, just change default from "eng" to "en"
```

**Change language codes from "eng" to "en"** — use ISO 639-1 (2-letter) codes consistently: `en`, `es`, `fr`, `pt`, `de`, `ko`. Shorter, more standard, matches `?lang=` param.

**Unique constraints:** Change `paragraphs.globalId` unique index to composite `(globalId, language)`. Same paragraph can exist in multiple languages.

**Primary key strategy:** Current PK is `id` (= globalId like `"1:2.0.1"`). For multi-language, make PK `language:globalId` (e.g., `"en:1:2.0.1"`, `"es:1:2.0.1"`). Same for parts, papers, sections — prefix `id` with language.

**Add indices:**
```sql
CREATE INDEX paragraphs_language_idx ON paragraphs(language);
CREATE INDEX papers_language_idx ON papers(language);
```

### Step A2: Validator & Schema Changes

**`src/validators/schemas.ts`:**

Add language query schema:
```typescript
export const LangQuery = z.object({
  lang: z.enum(["en", "es", "fr", "pt", "de", "ko"]).default("en"),
});
```

Add `language` field back to response schemas:
```typescript
// ParagraphSchema — add language field
language: z.string(),

// PaperSchema — add language field
language: z.string(),
```

Update SearchRequest/SemanticSearchRequest to include `lang`.

### Step A3: Route Changes (all 5 route files)

**Pattern for every endpoint:**
1. Accept `lang` from query params (GET) or body (POST)
2. Default to `"en"` when omitted
3. Add `eq(table.language, lang)` to every WHERE clause

**`src/routes/paragraphs.ts`:**
- Add `LangQuery` to all 3 routes' request.query
- Update `paragraphFields` to include `language`
- Update `findParagraphByRef` to accept and filter on language
- Add language filter to random, get, context queries

**`src/routes/papers.ts`:**
- Add `LangQuery` to all 3 routes
- Filter papers, paragraphs, sections by language

**`src/routes/toc.ts`:**
- Add `LangQuery` to GET /toc
- Filter parts and papers by language

**`src/routes/search.ts`:**
- Add `lang` to SearchRequest and SemanticSearchRequest body schemas
- Add language filter to WHERE clauses
- **FTS language mapping:** Replace hardcoded `'english'` with dynamic PostgreSQL language config:
  ```typescript
  const PG_LANG_MAP: Record<string, string> = {
    en: "english", es: "spanish", fr: "french",
    pt: "portuguese", de: "german", ko: "simple", // Korean uses 'simple' config
  };
  ```
- Rebuild search vectors per language during seeding

**`src/routes/audio.ts`:**
- Add `LangQuery` — audio is language-specific (different TTS for different languages eventually)
- For now, non-English paragraphs will have `audio: null`

### Step A4: Seed Script Updates

**`scripts/seed.ts`:**
- Accept `LANGUAGE` env var (default: `"en"`)
- When language is `"en"`, read from existing `urantia-papers-json/data/json/eng/` (current behavior)
- When language is other, read from `data/translations/{lang}/` (output of translation script)
- Prefix all IDs with language: `"es:1:2.0.1"` instead of `"1:2.0.1"`
- Set `language` column on all inserts
- Support `--all` flag to seed all available languages

**Migration for existing data:** Update all existing English rows to use `"en"` language code (currently `"eng"`) and prefix IDs.

### Step A5: FTS Setup for Multi-Language

**`scripts/setup-fts.sql`:**
- Create language-specific search vector triggers
- For each supported language, use the appropriate PostgreSQL text search config
- Korean/Japanese: use `simple` config (no stemming) since Postgres doesn't have native CJK support. Alternative: install `pg_bigm` extension for better CJK search.

---

## Part B: Translation Generation Script

### Overview

AI-translate all ~14,500 paragraphs + part/paper/section titles from English into 5 languages using the best available models. Output JSON files in the same `RawJsonNode` format the seed script expects.

### Model Choice

**Claude Sonnet (Recommended)** — Best quality-to-cost ratio for translation:
- Excellent at preserving meaning, tone, and style
- Good with religious/philosophical text
- Handles proper nouns consistently with instruction
- ~$3/1M input tokens, ~$15/1M output tokens
- The Urantia Book is ~1.1M words ~ ~1.5M tokens input per language
- Estimated cost per language: ~$5 input + ~$25 output = **~$30/language**
- **5 languages total: ~$150**

Alternative: GPT-4o (~$2.50/$10 per 1M tokens) — similar quality, slightly cheaper.

### Script: `scripts/translate/generate-translations.ts`

```
scripts/translate/
  generate-translations.ts    # Main batch translation script
  config.ts                   # Language configs, model settings, prompt templates
  validate-translations.ts    # QA: check completeness, detect untranslated passages
  output/                     # Generated JSON per language
    es/
      000.json ... 196.json
    fr/
    pt/
    de/
    ko/
```

### Translation Strategy

**Per-paper batch approach:** Translate one paper at a time (not paragraph-by-paragraph) to maintain contextual consistency within a paper. Each API call translates a full section (~5-30 paragraphs).

**System prompt:**
```
You are translating The Urantia Book into {language}.

Rules:
- Translate the meaning faithfully. Do not paraphrase or simplify.
- Preserve all proper nouns exactly as-is (do not translate names like
  "Nebadon", "Urantia", "Havona", "Melchizedek", etc.)
- Translate titles and common terms consistently (provide glossary).
- Maintain the formal, reverent tone of the original.
- Return JSON array matching the input structure exactly.
```

**Glossary per language:** Build a term glossary (God, Paradise, Thought Adjuster, etc.) from existing official translation conventions. Provide as context in each prompt for consistency.

**Resumability:** Track progress in `progress-{lang}.json`. Skip already-translated papers. Support `--paper=N` and `--lang=es` flags.

### Output Format

Match the existing `RawJsonNode` format used by `urantia-papers-json`:
```json
{
  "globalId": "1:2.0.1",
  "language": "es",
  "text": "PUESTO que el concepto mas elevado...",
  "htmlText": "<span class=\"...\">PUESTO que...</span>",
  "paperTitle": "La Naturaleza de Dios",
  "sectionTitle": "1. La Infinidad de Dios"
}
```
All other fields same as English — only text content is translated.

### QA Validation

**`scripts/translate/validate-translations.ts`:**
- Verify all 197 papers translated per language
- Verify paragraph count matches English (same number of paragraphs)
- Verify no untranslated English text leaked through (detect English in non-English output)
- Verify proper nouns preserved (spot-check "Urantia", "Nebadon" etc. appear unchanged)
- Verify JSON structure matches `RawJsonNode` schema

---

## Step-by-Step Execution Order

### Phase 1: API multi-language (Part A)
1. **A1** — DB schema migration (add language columns, update constraints)
2. **A2** — Validator/schema updates
3. **A3** — Route updates (all 5 files)
4. **A4** — Seed script updates + migrate existing English data
5. **A5** — FTS multi-language setup
6. Run existing tests — all should pass (English default)
7. Add new tests for `?lang=` parameter

### Phase 2: Translation generation (Part B)
1. Build translation script with Claude Sonnet
2. Generate translations for es, fr, pt, de, ko
3. Run QA validation
4. Seed translated data into DB
5. Test all endpoints with `?lang=es` etc.

### Phase 3: Docs & deploy
1. Update openapi.json with `lang` parameter on all endpoints
2. Update llms.txt and skill.md
3. Deploy

## Cost Estimate

| Item | Cost |
|------|------|
| Translation (5 languages x ~$30) | ~$150 |
| Embeddings for search (5 x ~$0.50) | ~$2.50 |
| Total | **~$150-$175** |

## Verification

```bash
# After Part A:
bun run typecheck
bun test                           # Existing tests pass (English default)
curl localhost:3000/paragraphs/2:0.1          # English (default)
curl localhost:3000/paragraphs/2:0.1?lang=en  # English (explicit)
curl localhost:3000/paragraphs/2:0.1?lang=es  # Spanish (after seeding)
curl -X POST localhost:3000/search -d '{"q":"Dios","lang":"es"}'

# After Part B:
bun run seed   # With LANGUAGE=es
curl localhost:3000/toc?lang=es
curl localhost:3000/papers/2?lang=fr
```

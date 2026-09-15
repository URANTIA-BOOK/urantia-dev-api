# Data Pipeline

Book **text** is owned by the language trees produced by the Urantia Book
pipeline (`URANTIA-BOOK/pipeline`). Each paper's companion (`part-1/001.json`)
is an envelope with `rows` and a `markdown` body. Audio, embeddings, entities,
and manifests still live in the **`urantia-data-sources`** Cloudflare R2 bucket.

## Data Flow

```
Language tree (URANTIA/source or langs/<repo>)
└── companions (*.json beside each .md)  ──→  bun run seed  ──→  parts, papers, sections, paragraphs

R2: urantia-data-sources bucket
├── entities/             ──→  bun run seed:entities  ──→  entities, paragraph_entities
├── embeddings/           ──→  (insert script)        ──→  paragraphs.embedding
├── manifests/            ──→  (joined during seed)   ──→  paragraphs.audio
└── audio/eng/            ──→  served via CDN at cdn.urantia.dev/audio/eng/
```

`json/eng/` on R2 is a retired copy of the old papers-JSON producer. Do not
re-upload companions there. Seed reads the tree in place via `BOOK_TREE`.

Seed still **serves** `text` and `htmlText` on the API. Those fields are derived
at ingest from `markdown` (emphasis flattened / wrapped). They are not stored
on the language tree. `labels` stay empty until `seed:entities`; they come from
the Urantiapedia topic index, not the book text.

## Setup from Scratch

### 1. Point seed at a language tree

English after `make langs-run L=eng` (or `make langs-run LOCAL=1`) lands in
`../URANTIA/source`. Other languages land in `../URANTIA/langs/<repo>`.

```bash
# English (also the default when that tree exists)
BOOK_TREE=../../URANTIA/source bun run seed:dry-run
BOOK_TREE=../../URANTIA/source bun run seed

# Spanish 1993
BOOK_TREE=../../URANTIA/langs/spanish bun run seed:dry-run
```

Audio, entities, and embeddings still come from R2:

```bash
cd ../urantia-data-sources
bun install
# Set up .env with R2 credentials (see .env.example)
bun run download entities     # entity seeds (~7MB)
bun run download manifests    # audio manifest (~2.6MB)
bun run download embeddings   # vector embeddings (~455MB, optional)
```

Or set env vars to point directly at the downloaded data (see `.env.example`).

A retired flat `data/json/eng` directory (bare arrays with `text` / `htmlText`)
still loads if `BOOK_TREE` is unset and no pipeline `metadata.json` is found.

### 2. Set up database

```bash
bun run db:push    # push schema to Supabase (dev)
# or
bun run db:migrate # run migrations (prod)
```

### 3. Seed in order

```bash
bun run seed:dry-run      # 0. Count companions without touching the DB
bun run seed              # 1. Papers, sections, paragraphs (+ audio from manifest)
bun run seed:entities     # 2. Entities + paragraph-entity junction table
bun run generate-embeddings  # 3. Vector embeddings (requires OPENAI_API_KEY, ~$5)
```

## Environment Variables

All data paths can be overridden via environment variables. See `.env.example` for the full list.

| Variable | Default | Used By |
|----------|---------|---------|
| `BOOK_TREE` | `../../URANTIA/source` when that tree exists, else `DATA_DIR` | `seed.ts`, `load-book.ts` |
| `DATA_DIR` | `../../urantia-data-sources/data/json/eng` | `seed.ts` (legacy alias / flat fallback) |
| `AUDIO_MANIFEST` | `../data/audio-manifest.json` | `seed.ts` |
| `SEED_ENTITIES_PATH` | `../data/entities/seed-entities.json` | `seed-entities.ts` |
| `MP3_DIR` | `../../urantia-data-sources/data/audio/eng` | `generate-audio-manifest.ts` |
| `EMBEDDINGS_PATH` | `data/embeddings.json` | `generate-embeddings.ts` |

## Official translations vs AI overlays

`scripts/seed-paragraph-translations.ts` reads `data/translations/{lang}/`,
which was generated as an AI overlay (`MULTI_LANGUAGE_GAMEPLAN.md`). Foundation
editions already exist as pipeline trees (`make langs-run`). Those companions
are the source of truth for published text. Do not replace an official edition
with an AI translation. Overlay only languages the Foundation has not
published; a later change should seed official trees into
`paragraph_translations` with `source` set to the edition, not `openai`.

The paragraphs table currently unique-indexes `globalId` without language, so
this seed script is English (or one language at a time as the primary text).
Do not insert a second language into `paragraphs` until that constraint is
composite.

## Regenerating Derived Data

### Entities

Entities are derived from the [Urantiapedia](https://github.com/JanHerca/urantiapedia) topic index. To regenerate:

```bash
# Requires urantiapedia repo cloned as a sibling
TOPIC_INDEX_DIR=../../urantiapedia/input/txt/topic-index-en bun scripts/entities/parse-topic-index.ts
bun scripts/entities/build-paragraph-map.ts
# Then re-seed:
bun run seed:entities
```

### Audio Manifest

Regenerate from the MP3 files in R2/local:

```bash
bun run generate-manifest
```

This writes two copies: `data/audio-manifest.json` here, which `seed.ts` reads, and
`../urantia-data-sources/data/manifests/audio-manifest.json`, which the upload script
publishes. Regenerating does not publish. Upload it as a second step:

```bash
cd ../urantia-data-sources && bun run upload manifests
```

Both copies are gitignored, so nothing warns you when the published manifest falls
behind. It sat 19 days stale in August 2026 for exactly this reason. Check it with:

```bash
curl -s https://cdn.urantia.dev/manifests/audio-manifest.json | head -c 400
```

### Embeddings

Regenerate via OpenAI API (costs ~$5):

```bash
bun run generate-embeddings
```

## Database Tables

| Table | Records | Source |
|-------|---------|--------|
| `parts` | 5 | language tree companions |
| `papers` | 197 | language tree companions |
| `sections` | ~1,626 | language tree companions |
| `paragraphs` | ~14,586 | language tree companions + embeddings + audio manifest |
| `entities` | ~3,000+ | entities/seed-entities.json |
| `paragraph_entities` | ~50,000+ | entities/seed-entities.json (citations resolved) |

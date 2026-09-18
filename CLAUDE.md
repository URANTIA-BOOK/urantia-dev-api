# urantia-dev-api

AI/developer-first API for the Urantia Papers — the **hub product's**
backend service.

## Scope of this service

This service owns Papers content (text, paragraphs, entities, search,
audio) and the hub product's per-user data (bookmarks, notes, reading
progress, preferences). It also hosts the shared OAuth infrastructure
(`/auth/*` — app registry, auth codes, token exchange) because that was
the natural first home for it.

**This is NOT a catch-all backend for every Urantia app.** Other product
apps get their own services with their own databases:

- `urantia-listen-api/` — Listen app (audio transcripts, semantic hits,
  streaming insights)
- future product apps — same pattern

All backends validate tokens issued by `accounts.urantiahub.com`, but each
owns its own schema, migrations, deploy, secrets, and data retention
rules. Don't bolt new product features onto this repo just because the
auth middleware is already wired up — stand up a new service.

## Tech Stack

- Runtime: Bun
- Framework: Hono + @hono/zod-openapi
- ORM: Drizzle
- Database: Supabase (Postgres + pgvector)
- Validation: Zod v4
- Linting: Biome

## Dependency and toolchain pins

- `bun.lock` is the ONLY lockfile. A stale leftover `yarn.lock` sat here until
  2026-08-19 and kept 51 Dependabot alerts open after the real deps were fixed —
  GitHub scans every lockfile it finds. Never add a second one.
- `wrangler` pinned exact `4.73.0` — 4.124+ requires Node 22 and this machine
  runs Node 20. Bumping it breaks `bun run deploy` locally.
- `@biomejs/biome` pinned exact `2.4.7` — 2.5.x changes formatting rules and
  flags untouched files. Bump it only together with a deliberate repo-wide
  `bun run format`.
- `overrides.yaml` forces the patched transitive `yaml` version.
- Known baseline (pre-existing, not regressions): 223 typecheck errors and 43
  Biome lint errors, measured 2026-09-18 on a clean `main`. Most typecheck
  errors are Hono handler return-type mismatches in `src/routes/*.ts` plus
  `unknown` body types in the test files. Compare counts against this baseline
  before blaming a change.

## Testing against production

`bun test` runs the Hono app in-process with the real `.env`, which points at
the production database. The unit/middleware suites and the content
integration suites (papers, toc, search, root, mcp, tools) are read-only and
safe. The `auth`/`me` suites can write; run them only deliberately.

## Commands

- `bun run dev` — Start dev server with hot reload
- `bun run seed` — Seed database from JSON files
- `bun run db:generate` — Generate Drizzle migrations
- `bun run db:push` — Push schema to database
- `bun run typecheck` — Type check
- `bun run lint` — Lint with Biome
- `bun run deploy` — Deploy to Cloudflare Workers and warm the cache (see Deploy + cache warmup)

## Deploy + cache warmup

`bun run deploy` runs `scripts/deploy.sh`, which does `wrangler deploy` and
then hits `/health` and `/search/semantic?q=warmup&limit=1`.

The warmup hit is load-bearing, not cosmetic. `/search/semantic` uses a KV
cache (`SEARCH_CACHE` binding) for query embeddings and filter-tuple counts.
Without the warmup, the first real user query after a deploy eats the cold
path: fresh Worker isolate, cold Hyperdrive pool, no cached `count(*)` —
roughly 2s. With the warmup, the unfiltered count cache is populated and the
steady-state floor is ~300ms.

Do not strip the warmup from the deploy script. If you change the cache key
scheme in `src/lib/search-cache.ts` (bump `COUNT_KEY_VERSION`), the warmup is
what rebuilds the hot set after the rollout.

## Project Structure

- `src/index.ts` — Hono app entry point
- `src/db/schema.ts` — Drizzle table definitions (content tables + auth/user tables)
- `src/db/client.ts` — Database client
- `src/lib/logger.ts` — BetterStack logger factory (dev fallback to console)
- `src/lib/errors.ts` — RFC 9457 problem+json error responses
- `src/lib/paragraph-lookup.ts` — Shared paragraph ref resolution + batch lookup
- `src/routes/` — API route handlers
  - `papers.ts`, `paragraphs.ts`, `search.ts`, `entities.ts`, `audio.ts`, `toc.ts` — Public content routes
  - `me.ts` — Authenticated user data (bookmarks, notes, reading progress, preferences)
  - `auth.ts` — OAuth endpoints (app registration, authorization codes, token exchange)
  - `cite.ts`, `og.ts`, `embeddings.ts`, `mcp.ts` — Utility routes
- `src/middleware/` — CORS, structured logging, rate limiting, cache control, JWT auth
  - `auth.ts` — Dual JWT validation: Supabase JWKS (ECC P-256) + app tokens (HS256 via APP_JWT_SECRET), lazy user creation
- `src/validators/` — Zod schemas for request/response
  - `schemas.ts` — Public endpoint schemas
  - `me-schemas.ts` — Authenticated endpoint schemas
- `src/types/node.ts` — TypeScript types + ref format detection
- `scripts/seed.ts` — Database seeder from urantia-papers-json
- `scripts/setup-fts.sql` — Full-text search setup SQL
- `docs/plans/unified-auth-layer.md` — Full design spec for the unified auth layer

## SDKs

Official TypeScript SDKs published on npm (`urantia-dev-sdks/` repo):
- `@urantia/api` (v0.1.0) — Typed fetch client for all endpoints (public + authenticated)
- `@urantia/auth` (v0.1.0) — OAuth client for accounts.urantiahub.com (PKCE, popup/redirect, session management)

## Environment Variables

- `DATABASE_URL` — Supabase Postgres connection string
- `SUPABASE_URL` — Supabase project URL (for JWKS endpoint)
- `APP_JWT_SECRET` — HS256 secret for signing app-scoped access tokens (generated, not from Supabase)
- `ADMIN_USER_IDS` — Comma-separated Supabase user UUIDs that can register OAuth apps
- `OPENAI_API_KEY` — For semantic search embeddings
- `BETTERSTACK_SOURCE_TOKEN` — BetterStack logging
- `CF_ANALYTICS_API_TOKEN` — Cloudflare API token (Analytics:Read on the zone) for `/admin/stats`
- `CF_ZONE_TAG` — Cloudflare zone tag (the `api.urantia.dev` zone) for `/admin/stats`

## Auth Layer (on `auth` branch)

The API includes a unified auth layer for the Urantia ecosystem:

- **Identity**: Supabase Auth (GoTrue) with ECC P-256 JWT signing
- **JWT validation**: Dual path — Supabase JWKS (ECC P-256) for session tokens, HS256 via `APP_JWT_SECRET` for app-scoped tokens
- **Token exchange**: `POST /auth/token` returns a signed HS256 JWT (7-day expiry) with claims: `sub`, `email`, `scopes`, `app_id`, `iss`, `aud`
- **Login page**: accounts.urantiahub.com (separate Next.js app in `urantia-accounts/`)
- **User data tables**: users, bookmarks, notes, reading_progress, user_preferences, apps, app_user_data, auth_codes
- **Authenticated endpoints**: `/me/*` (bookmarks, notes, reading progress, preferences)
- **OAuth endpoints**: `/auth/*` (app registration, authorization codes, token exchange)
- **App-tagged data**: All user data has an `appId` column (defaults to "default", scoped per-app in future)
- **Forward compat**: `visibility` column on bookmarks/notes (private/public/group)

## Audio

Audio lives on `cdn.urantia.dev`, not on `audio.urantia.dev`.

- Paragraph: `cdn.urantia.dev/audio/eng/paragraphs/{voice}/{model}-{voice}-{globalId}.mp3`
- Paper: `cdn.urantia.dev/audio/eng/papers/{paperId}.mp3` (0 is the Foreword)
- Part: `cdn.urantia.dev/audio/eng/parts/{model}-{voice}-Part{n}.mp3`

`audio.urantia.dev` still resolves. It is a frozen snapshot that holds nova files
only. A nova URL returns 200 there, so the host looks healthy while every other
voice 404s. Never test that host with a nova path alone.

Only `tts-1-hd`/`nova` covers all 16,220 paragraphs. `gpt-4o-mini-tts`/`cedar`
covers 3,438, `tts-1-hd`/`onyx` 231, and the rest are under a dozen samples each.
Read the `audio` object on the paragraph. Do not build a URL for a non-nova voice.

The manifest has two copies and both are gitignored. `generate-audio-manifest.ts`
writes `data/audio-manifest.json` for `seed.ts` and a second copy into
`../urantia-data-sources/data/manifests/`, which is what `bun run upload manifests`
publishes. Generating does not publish. See `DATA_PIPELINE.md`.

## Documentation

- `FEATURES.md` — Consumer-facing feature list. Keep up to date when endpoints change.
- `TODO.md` — Running list of planned work.
- `docs/plans/unified-auth-layer.md` — Design spec for the auth layer.

## Bible corpus + cross-references (UB ↔ Bible)

This API hosts the World English Bible (eng-web) as a queryable resource.
38,034 verses across 81 books (39 OT + 15 deuterocanonical + 27 NT). Public
domain text from eBible.org; stored in `bible_verses`. Source: the USFM bundle
lives at `urantia-data-sources/data/bible/eng-web_usfm.zip` (snapshot date
captured in `bible_verses.source_version` so future re-seeds can diff).

**Embeddings (Phase 2):** `paragraphs.embedding_v2` (3072-d) and
`bible_chunks.embedding` (3072-d) hold `text-embedding-3-large` vectors used
by Phase 3 cross-references. The existing `paragraphs.embedding` (1536-d)
column still backs `/search/semantic` and `/embeddings/{ref}` — switching
those endpoints to the new column is a deferred coordinated step. Bible
chunks are paragraph-grain (USFM `\p`/`\q1`/etc. boundaries) — verse-grain
embeddings carry too little signal for short verses like John 11:35.

**Cross-references:** three pre-computed cross-reference tables, all using
`text-embedding-3-large` cosine similarity, all top-10 per source:
- `bible_parallels` — UB↔Bible in both directions (Phase 3)
- `urantia_parallels` — UB↔UB ("see also" between Urantia paragraphs)

The seed scripts (`scripts/seed-bible-parallels.ts`,
`scripts/seed-urantia-parallels.ts`) compute dot products in-memory in Bun —
pgvector can't index 3072-d vectors with HNSW (capped at 2000), and
sequential-scan SQL times out on a hosted DB. Both seeds use
`ON CONFLICT DO UPDATE` so re-runs after a model upgrade overwrite cleanly.

**Surface:**
- `GET /paragraphs/{ref}?include=urantiaParallels` — top-10 similar UB paragraphs
- `GET /paragraphs/{ref}?include=bibleParallels` — top-10 Bible verses
- `GET /bible/{bcv}/urantia-parallels` — reverse query, top-10 UB paragraphs for a Bible verse
- All three include params combine: `?include=entities,bibleParallels,urantiaParallels`
- RAG format (`?format=rag`) renders any combination inline

**Embeddings endpoint (`GET /embeddings/{ref}`):** accepts `?model=small|large`.
Default is `large` (3072-d). Response carries `model` + `dimensions` body
fields and `X-Embedding-Model` response header so consumers can detect
mismatches if they cache vectors. `/embeddings/export?paperId=X` accepts
the same param.

**Why /search/semantic stays on 3-small:** pgvector's HNSW caps at 2000
dimensions. We HNSW-index `paragraphs.embedding` (1536-d) only — without
the index every query is sequential scan (~14s). The +8pt benchmark
benefit of 3-large was on Bible-on-Bible retrieval, not directly relevant
to UB-on-UB live queries. **Important:** the HNSW index is declared in
`src/db/schema.ts` so `bun run db:push` does NOT silently drop it. If you
ever see /search/semantic latency jump from <1s to >10s, the first thing
to check is whether the `paragraphs_embedding_hnsw_idx` index still
exists in production.

**Honest framing:** these are *semantic* parallels, not curated. Faw-recall
(`scripts/validate-paramony-recall.ts`) measures overlap with Faw's 1986
Paramony at ~25% recall@10. That's by design — Faw picked LINGUISTIC
parallels for human readers (specific verse allusions), our embeddings pick
CONCEPTUAL parallels for AI agents (thematic neighbors). Top results are
qualitatively excellent (Matt 5:3 → UB 140:3.3 at 0.854: UB rephrases the
Beatitudes). Schema reserves `source: "paramony"` for an optional curated
layer if Faw's license ever clears.

**OSIS conventions:** book codes follow CrossWire OSIS (`Gen`, `Matt`,
`1Macc`, `DanGr`). API endpoints accept OSIS, USFM (`GEN`), full names,
and aliases (case-insensitive, hyphens/underscores tolerated) via
`src/lib/bible-canonicalizer.ts`.

**WEB Classic note:** we use `eng-web` (Yahweh-rendering) intentionally — it
aligns with the Urantia Papers' usage of "Yahweh" in Papers 96–97. Don't
swap to `eng-webbe` (British) or `eng-webp` (Protestant subset, no
deuterocanon) without revisiting that choice.

**Embedded books:** WEB ecumenical edition embeds Prayer of Azariah, Susanna,
and Bel and the Dragon inside Greek Daniel (`DanGr`); Letter of Jeremiah is
Baruch chapter 6. The canonicalizer resolves their alternate names back to
the containing book.

The Bible exists in this codebase as Phase 1 of a three-phase cross-reference
build (see `docs/plans/bible-cross-references.md` if it exists, or just
`/Users/kelsonic/.claude/plans/whimsical-yawning-sketch.md`). Phase 2 adds
embeddings (`text-embedding-3-large`), Phase 3 pre-computes bidirectional
UB↔Bible parallels. Don't bolt unrelated Bible features on without
re-reading the plan.

## Distribution

The MCP server and REST API are listed across several AI/dev directories. Before
adding new submission work, check what's already done so you don't duplicate it.
See `TODO.md` "API & MCP directory listings" for the live state of in-flight
review queues.

- **MCP Registry**: published as `dev.urantia/urantia-papers` (`server.json`).
  Namespace is DNS-authenticated via `dev.urantia` so org membership stays
  private — do not switch this back to a `urantia-hub/*` (GitHub-auth) namespace.
  Republishing rules: bump `server.json` `version` first, keep `description`
  ≤100 chars (registry rejects longer with a 422), and use `mcp-publisher
  validate` before `publish`. Auth key + exact command are out-of-band; ask
  Kelson if you need the operator playbook.
- **Smithery**: hosted listing at `urantiahub/urantia-papers` (badge in README).
- **Glama**: dual listing — Connector tab (hosted endpoint, A grades) and Server
  tab (`glama.json` claims maintainer `kelsonic`). Server-tab grade is capped at
  C because we have no Dockerfile-installable stdio mode. Don't refactor to a
  stdio MCP server just to chase Glama's A grade — Kelson explicitly rejected
  that path. The `Dockerfile` in the repo is for local/self-hosted runs only,
  not for Glama Path A.
- **Connector verification**: `/.well-known/glama.json` in `src/index.ts`.
- **Function-calling schemas**: `/tools/openai` and `/tools/anthropic` are public
  endpoints that ship the same 19 MCP tools (13 UB + 6 Bible/cross-reference)
  as ready-to-use OpenAI/Anthropic tool definitions. Source of truth lives in
  `src/lib/tool-catalog.ts`.

## Observability

- **Logging**: BetterStack via `@logtail/edge`. Structured JSON logs with request metadata.
- **Metrics**: Search queries and endpoint usage are logged as structured events to BetterStack, queryable via SQL dashboards.
- **Error tracking**: Global error handler sends stack traces to BetterStack.
- **Health check**: `GET /health` verifies DB connectivity.
- **Uptime monitoring**: BetterStack uptime monitor on `/health`.
- **Admin stats**: `GET /admin/stats?window=1h|24h|7d` aggregates Cloudflare GraphQL Analytics
  (request counts, status buckets, top paths with origin latency quantiles, top countries,
  user-agent families) plus DB counters (apps, users, refresh grants in window) plus a KV
  cache-warmth gauge. Gated by `ADMIN_USER_IDS`; returns 404 for non-admins so the
  endpoint is invisible to scrapers. Excluded from `/openapi.json`. User-agent strings are
  bucketed into coarse families (`claude-code`, `openai`, `browser`, etc.) via
  `src/lib/ua-family.ts` so individual callers cannot be fingerprinted from the response.
  Source-of-truth files: `src/routes/admin.ts`, `src/lib/cf-analytics.ts`.


**Bible semantic search:** `POST /bible/search/semantic` does live free-form
search over the Bible at 1536-d (`bible_chunks.embedding_small`, HNSW-indexed)
and joins each result against `bible_parallels` (direction='bible_to_ub') so
Bible hits arrive with the relevant Urantia paragraphs already attached.
This is the urantia.dev API — Bible search without UB content would miss the
point. Filters: `canon`, `bookCode`, `paragraphLimit` (0-10).

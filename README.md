# Urantia Papers API

[![smithery badge](https://smithery.ai/badge/urantiahub/urantia-papers)](https://smithery.ai/servers/urantiahub/urantia-papers)

A developer and AI-agent friendly API for the Urantia Papers. Provides full-text search, structured content access, and audio URLs for all 14,500+ paragraphs across 197 papers.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/toc` | Table of contents (parts → papers) |
| GET | `/papers` | List all 197 papers |
| GET | `/papers/:id` | Single paper with all paragraphs |
| GET | `/papers/:id/sections` | Sections within a paper |
| GET | `/paragraphs/random` | Random paragraph |
| GET | `/paragraphs/:ref` | Paragraph by any ID format |
| GET | `/paragraphs/:ref/context` | Paragraph with surrounding context |
| POST | `/search` | Full-text search with pagination |
| GET | `/audio/:paragraphId` | Audio info for a paragraph |
| POST | `/search/semantic` | Semantic (vector) search |
| GET | `/entities` | List entities (beings, places, concepts, etc.) |
| GET | `/entities/:id` | Entity details |
| GET | `/entities/:id/paragraphs` | Paragraphs mentioning an entity |
| GET | `/cite` | Generate citation (APA, MLA, Chicago, BibTeX) |
| GET | `/og/:ref` | Dynamic Open Graph image |
| POST | `/embeddings` | Vector embeddings for paragraphs |
| GET | `/me` | User profile (auth required) |
| POST | `/me/bookmarks` | Create bookmark (auth required) |
| GET | `/me/bookmarks` | List bookmarks (auth required) |
| GET | `/me/notes` | List notes (auth required) |
| POST | `/me/notes` | Create note (auth required) |
| GET | `/me/reading-progress` | Reading progress (auth required) |
| GET | `/me/preferences` | User preferences (auth required) |
| POST | `/auth/authorize` | Get authorization code (auth required) |
| POST | `/auth/token` | Exchange code for token |
| GET | `/auth/apps/:id` | Get OAuth app info |

Interactive docs available at `/docs` (Swagger UI). OpenAPI spec at `/openapi.json`.

## SDKs

Official TypeScript SDKs are available on npm:

```bash
npm install @urantia/api    # Typed client for all endpoints
npm install @urantia/auth   # OAuth client for accounts.urantiahub.com
```

See [urantia.dev/sdks](https://urantia.dev/sdks) for documentation.

## Paragraph ID Formats

The API accepts three reference formats — auto-detected from the string:

| Format | Example | Structure |
|--------|---------|-----------|
| globalId | `1:2.0.1` | `partId:paperId.sectionId.paragraphId` |
| standardReferenceId | `2:0.1` | `paperId:sectionId.paragraphId` |
| paperSectionParagraphId | `2.0.1` | `paperId.sectionId.paragraphId` |

## Search

```bash
curl -X POST https://api.urantia.dev/search \
  -H "Content-Type: application/json" \
  -d '{"q": "Universal Father", "limit": 10, "type": "and"}'
```

Search modes: `and` (all words, default), `or` (any word), `phrase` (exact match). Optional filters: `paperId`, `partId`.

## Audio

Paragraphs include an `audio` field — a nested object keyed by model and voice, or `null` if no audio exists:

```json
{
  "audio": {
    "tts-1-hd": {
      "nova": {
        "format": "mp3",
        "url": "https://cdn.urantia.dev/audio/eng/paragraphs/nova/tts-1-hd-nova-3:119.1.5.mp3",
        "bitrate": 160,
        "duration": 43.3,
        "fileSize": 866400
      }
    }
  }
}
```

Available models and voices vary per paragraph. The dedicated `/audio/:paragraphId` endpoint returns just the audio data for a given paragraph.

## Caching

Responses include `Cache-Control` headers. Cloudflare's CDN caches at the edge via `s-maxage`:

| Route | CDN (s-maxage) | Browser (max-age) |
|-------|---------------|-------------------|
| `/toc`, `/papers/*`, `/paragraphs/:ref`, `/audio/*` | 24 hours | 1 hour |
| `/search` | 1 hour | 5 minutes |
| `/paragraphs/random` | no-store | no-store |
| `/`, `/docs`, `/openapi.json` | 1 hour | 5 minutes |

## For AI Agents

Recommended flow:

1. `GET /toc` — understand the book structure
2. `POST /search` — find relevant passages
3. `GET /paragraphs/:ref/context?window=3` — get surrounding context
4. `GET /papers/:id` — read a full paper

## MCP Server

The API includes a built-in [MCP](https://modelcontextprotocol.io) server at `https://api.urantia.dev/mcp` — connect Claude Desktop, Cursor, or any MCP client to access:

- **19 tools** — search, paragraph lookup, paper navigation, entity browsing, audio, Bible (WEB) lookup + semantic search, and bidirectional cross-reference enrichment between Urantia and Bible passages (plus paragraph-to-paragraph parallels within the Papers)
- **2 resource templates** — `urantia://paper/{id}` (markdown) and `urantia://entity/{id}`
- **2 prompt templates** — `study_assistant`, `comparative_theology`

One-click install via [Smithery](https://smithery.ai/servers/urantiahub/urantia-papers).

## Authentication

Public endpoints require no auth. User endpoints (`/me/*`) require a JWT. OAuth flow:

1. Register an app via `POST /auth/apps` (admin) or self-service at accounts.urantiahub.com/developer
2. User signs in at [accounts.urantiahub.com](https://accounts.urantiahub.com)
3. Exchange authorization code for access token via `POST /auth/token`
4. Pass token as `Authorization: Bearer <token>`

Access tokens are HS256 JWTs with 7-day expiry. PKCE is supported for browser-based apps.

## Observability

- **Logging:** BetterStack via `@logtail/edge` — structured JSON logs with request metadata
- **Error tracking:** Global error handler sends stack traces to BetterStack
- **Health check:** `GET /health` — verifies DB connectivity
- **Uptime:** BetterStack uptime monitor

## Tech Stack

- **Runtime:** [Bun](https://bun.sh) (dev) / [Cloudflare Workers](https://workers.cloudflare.com) (production)
- **Framework:** [Hono](https://hono.dev) + [@hono/zod-openapi](https://github.com/honojs/middleware/tree/main/packages/zod-openapi)
- **Database:** [Supabase](https://supabase.com) (PostgreSQL + pgvector)
- **ORM:** [Drizzle](https://orm.drizzle.team)
- **Observability:** [BetterStack](https://betterstack.com) (logging, uptime)

## Development

```bash
# Install dependencies
bun install

# Set up environment
cp .env.example .env
# Edit .env with your Supabase DATABASE_URL

# Push schema to database
bun run db:push

# Set up full-text search (run after db:push)
bun scripts/run-fts-setup.ts

# Generate audio manifest (requires ../urantia-hub-api)
bun run generate-manifest

# Prove companions load (no database)
bun run seed:dry-run

# Seed database from the language tree (BOOK_TREE / ../../URANTIA/source)
bun run seed

# Start dev server (hot reload)
bun run dev
```

The server runs at `http://localhost:3000` by default.

The `Dockerfile` is the versioned self-host image (`bun start`). Book trees
mount at `/book/eng` and `/book/langs`. Open `.devcontainer` to onboard the
module; the lab conductor builds this image and does not bind-mount API source
in prod.

## Deployment

Deployed to Cloudflare Workers. First-time setup:

```bash
npx wrangler login
npx wrangler secret put DATABASE_URL
# paste your Supabase connection string (use pooler port 6543)

npx wrangler secret put APP_JWT_SECRET
# paste a 64-byte hex secret: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

npx wrangler secret put ADMIN_USER_IDS
# comma-separated Supabase user UUIDs for admin access
```

Deploy:

```bash
bun run deploy
```

## Data

Book text is sourced from the language trees produced by [URANTIA-BOOK/pipeline](https://github.com/URANTIA-BOOK/pipeline) (JSON companions beside each paper). Audio is served from [cdn.urantia.dev](https://cdn.urantia.dev/audio/eng/papers/1.mp3). See [DATA_PIPELINE.md](DATA_PIPELINE.md).

## License

This project is licensed under the [MIT License](./LICENSE).

## Disclaimer

This is an independent community project by [Adams Technologies LLC](https://adamstechnologies.com). It is not affiliated with, endorsed by, or connected with Urantia Foundation. The original English text of *The Urantia Book* is in the public domain (*Michael Foundation v. Urantia Foundation*, 10th Cir. 2003). All use of "Urantia" is nominative fair use to identify the subject matter.

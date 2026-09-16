import {
	customType,
	index,
	integer,
	jsonb as pgJsonb,
	pgTable,
	real,
	serial,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({
	dataType() {
		return "tsvector";
	},
});

const vector = customType<{ data: number[] }>({
	dataType() {
		return "vector(1536)";
	},
});

const vector3072 = customType<{ data: number[] }>({
	dataType() {
		return "vector(3072)";
	},
});

type AudioVariant = { format: string; url: string };
type AudioData = Record<string, Record<string, AudioVariant>> | null;

type VideoVariant = { mp4: string; thumbnail: string; duration: number };
type VideoData = Record<string, VideoVariant> | null;

const videoJsonb = customType<{ data: VideoData }>({
	dataType() {
		return "jsonb";
	},
	toDriver(value: VideoData) {
		return value === null ? null : JSON.stringify(value);
	},
	fromDriver(value: unknown) {
		if (typeof value === "string") return JSON.parse(value) as VideoData;
		return value as VideoData;
	},
});

const jsonb = customType<{ data: AudioData }>({
	dataType() {
		return "jsonb";
	},
	toDriver(value: AudioData) {
		return value === null ? null : JSON.stringify(value);
	},
	fromDriver(value: unknown) {
		if (typeof value === "string") return JSON.parse(value) as AudioData;
		return value as AudioData;
	},
});

// --- parts ---
export const parts = pgTable("parts", {
	id: text("id").primaryKey(),
	title: text("title").notNull(),
	sponsorship: text("sponsorship"),
	sortId: text("sort_id").notNull(),
});

// --- papers ---
export const papers = pgTable(
	"papers",
	{
		id: text("id").primaryKey(),
		partId: text("part_id")
			.notNull()
			.references(() => parts.id),
		title: text("title").notNull(),
		globalId: text("global_id").notNull(),
		sortId: text("sort_id").notNull(),
		labels: text("labels").array(),
		video: videoJsonb("video"),
	},
	(t) => [index("papers_part_id_idx").on(t.partId)],
);

// --- sections ---
export const sections = pgTable(
	"sections",
	{
		id: text("id").primaryKey(),
		paperId: text("paper_id")
			.notNull()
			.references(() => papers.id),
		sectionId: text("section_id").notNull(),
		title: text("title"),
		globalId: text("global_id").notNull(),
		sortId: text("sort_id").notNull(),
	},
	(t) => [index("sections_paper_id_idx").on(t.paperId)],
);

// --- paragraphs ---
export const paragraphs = pgTable(
	"paragraphs",
	{
		id: text("id").primaryKey(),
		globalId: text("global_id").notNull().unique(),
		standardReferenceId: text("standard_reference_id").notNull(),
		paperSectionParagraphId: text("paper_section_paragraph_id").notNull(),
		sortId: text("sort_id").notNull(),

		paperId: text("paper_id")
			.notNull()
			.references(() => papers.id),
		sectionId: text("section_id").references(() => sections.id),
		partId: text("part_id")
			.notNull()
			.references(() => parts.id),

		paperTitle: text("paper_title").notNull(),
		sectionTitle: text("section_title"),
		paragraphId: text("paragraph_id").notNull(),
		language: text("language").notNull().default("eng"),

		text: text("text").notNull(),
		htmlText: text("html_text").notNull(),

		labels: text("labels").array(),

		// Full-text search — populated via SQL generated column (see setup-fts.sql)
		searchVector: tsvector("search_vector"),

		// Semantic search — populated later via generate-embeddings script
		embedding: vector("embedding"),

		// Phase 2 — text-embedding-3-large (3072-d). Populated alongside the
		// existing 1536-d column so /search/semantic can be cut over without
		// downtime via a flag-gated read switch.
		embeddingV2: vector3072("embedding_v2"),

		audio: jsonb("audio"),
	},
	(t) => [
		index("paragraphs_paper_id_idx").on(t.paperId),
		index("paragraphs_section_id_idx").on(t.sectionId),
		index("paragraphs_sort_id_idx").on(t.sortId),
		index("paragraphs_std_ref_idx").on(t.standardReferenceId),
		index("paragraphs_psp_id_idx").on(t.paperSectionParagraphId),
		// HNSW index on the 1536-d 3-small embedding column. /search/semantic
		// queries depend on this — without it, every query is a sequential
		// scan over 14,593 vectors (~14s instead of <300ms). Declared here so
		// `bun run db:push` doesn't silently drop it. Note: pgvector caps HNSW
		// at 2000 dimensions for the regular `vector` type, which is why we
		// only index `embedding` (1536-d) and not `embedding_v2` (3072-d).
		index("paragraphs_embedding_hnsw_idx")
			.using("hnsw", t.embedding.op("vector_cosine_ops"))
			.with({ m: 16, ef_construction: 64 }),
	],
);

// --- entities ---
export const entities = pgTable(
	"entities",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		type: text("type").notNull(),
		aliases: text("aliases").array(),
		description: text("description"),
		seeAlso: text("see_also").array(),
		citationCount: integer("citation_count").notNull(),
	},
	(t) => [index("entities_type_idx").on(t.type)],
);

// --- entity_translations ---
export const entityTranslations = pgTable(
	"entity_translations",
	{
		id: text("id").primaryKey(), // "{entityId}:{lang}:{source}:v{version}"
		entityId: text("entity_id")
			.notNull()
			.references(() => entities.id),
		language: text("language").notNull(), // ISO 639-1: "nl", "es", "fr"
		source: text("source").notNull(), // "foundation" | "urantia.dev"
		version: integer("version").notNull().default(1),
		name: text("name").notNull(),
		aliases: text("aliases").array(),
		description: text("description"),
		confidence: text("confidence"), // "high" | "medium" | "needs_manual"
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(t) => [
		index("et_entity_lang_idx").on(t.entityId, t.language),
		index("et_lang_source_idx").on(t.language, t.source),
		uniqueIndex("et_entity_lang_source_version_idx").on(
			t.entityId,
			t.language,
			t.source,
			t.version,
		),
	],
);

// --- paragraph_entities (junction) ---
export const paragraphEntities = pgTable(
	"paragraph_entities",
	{
		paragraphId: text("paragraph_id")
			.notNull()
			.references(() => paragraphs.id),
		entityId: text("entity_id")
			.notNull()
			.references(() => entities.id),
	},
	(t) => [
		index("pe_paragraph_id_idx").on(t.paragraphId),
		index("pe_entity_id_idx").on(t.entityId),
	],
);

// --- paragraph_translations ---
export const paragraphTranslations = pgTable(
	"paragraph_translations",
	{
		id: text("id").primaryKey(), // "{paragraphId}:{lang}:v{version}"
		paragraphId: text("paragraph_id")
			.notNull()
			.references(() => paragraphs.id),
		language: text("language").notNull(), // ISO 639-1: "es", "fr", "pt", "de", "ko"
		version: integer("version").notNull().default(1),
		text: text("text").notNull(),
		htmlText: text("html_text").notNull(),
		source: text("source").notNull().default("urantia.dev"),
		confidence: text("confidence"), // "high" | "medium" | "needs_review"
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("pt_paragraph_lang_version_idx").on(
			t.paragraphId,
			t.language,
			t.version,
		),
		index("pt_language_idx").on(t.language),
		index("pt_paragraph_id_idx").on(t.paragraphId),
	],
);

// --- title_translations ---
export const titleTranslations = pgTable(
	"title_translations",
	{
		id: text("id").primaryKey(), // "{sourceType}:{sourceId}:{lang}:v{version}"
		sourceType: text("source_type").notNull(), // "paper" | "section" | "part" | "partSponsorship"
		sourceId: text("source_id").notNull(), // paper.id or section.id
		language: text("language").notNull(),
		version: integer("version").notNull().default(1),
		title: text("title").notNull(),
		source: text("source").notNull().default("urantia.dev"),
		confidence: text("confidence"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("tt_type_source_lang_version_idx").on(
			t.sourceType,
			t.sourceId,
			t.language,
			t.version,
		),
		index("tt_language_idx").on(t.language),
		index("tt_source_type_id_idx").on(t.sourceType, t.sourceId),
	],
);

// --- bible_chunks (paragraph-grain groups for embedding) ---
// Each chunk corresponds to one logical paragraph in the WEB USFM source —
// driven by the parser's paragraphIndex counter. Chunk text is the
// concatenation of all verses sharing the same (book, paragraphIndex).
//
// Phase 2 embeds chunks (not individual verses) because short verses like
// "Jesus wept." (John 11:35) carry almost no embeddable signal in isolation.
// Paragraph granularity matches the UB side and matches Faw's grain.
//
// Chunk ids encode the verse range they cover, e.g. "Gen.1.1-5" or
// "John.11.35" (single-verse chunks omit the dash form).
export const bibleChunks = pgTable(
	"bible_chunks",
	{
		id: text("id").primaryKey(),
		bookCode: text("book_code").notNull(),
		chapter: integer("chapter").notNull(),
		verseStart: integer("verse_start").notNull(),
		verseEnd: integer("verse_end").notNull(),
		text: text("text").notNull(),
		// Full-precision 3072-d 3-large vectors used for the pre-computed
		// cross-reference tables. Not HNSW-indexable (pgvector caps at 2000
		// dims for the regular `vector` type).
		embedding: vector3072("embedding"),
		// 1536-d 3-small vectors used by the live Bible semantic search.
		// Mirrors the strategy on `paragraphs.embedding`: HNSW-indexable so
		// queries hit ~50ms instead of multi-second sequential scan.
		embeddingSmall: vector("embedding_small"),
		embeddingModel: text("embedding_model"),
	},
	(t) => [
		index("bc_book_chapter_idx").on(t.bookCode, t.chapter),
		index("bc_book_chapter_start_idx").on(t.bookCode, t.chapter, t.verseStart),
		index("bc_embedding_small_hnsw_idx")
			.using("hnsw", t.embeddingSmall.op("vector_cosine_ops"))
			.with({ m: 16, ef_construction: 64 }),
	],
);

// --- bible_verses (World English Bible, public domain) ---
// One row per verse across 81 books (39 OT + 15 deuterocanon + 27 NT).
// Source: eBible.org `eng-web` USFM bundle. Translation `web` is reserved
// for "faithful copies" per WEB's only license constraint (the name).
// `paragraphMarker` is captured at ingest from USFM `\p`/`\m`/`\q*`/`\m1`
// markers — Phase 1 doesn't use it, but Phase 2 groups verses into chunks
// by paragraph marker for embedding and we'd otherwise have to re-parse.
// `sourceVersion` records the eBible.org snapshot date (e.g., "web-2026-04-23")
// so we can diff which verses changed when eBible.org publishes a correction.
export const bibleVerses = pgTable(
	"bible_verses",
	{
		id: text("id").primaryKey(), // OSIS-style: "Gen.1.1"
		bookCode: text("book_code").notNull(), // OSIS: "Gen", "Matt", "1Macc", "DanGr"
		bookName: text("book_name").notNull(), // "Genesis", "1 Maccabees", "Daniel (Greek)"
		bookOrder: integer("book_order").notNull(), // 1..81 canonical traversal
		canon: text("canon").notNull(), // "ot" | "deuterocanon" | "nt"
		chapter: integer("chapter").notNull(),
		verse: integer("verse").notNull(),
		text: text("text").notNull(),
		paragraphMarker: text("paragraph_marker"),
		// Per-book counter from the USFM parser. Increments each time a
		// paragraph marker (\p, \q1, \m, etc.) is encountered. Verses sharing
		// the same paragraphIndex live in the same logical paragraph and get
		// grouped into a single bible_chunk.
		paragraphIndex: integer("paragraph_index"),
		// FK to bible_chunks.id — the chunk this verse belongs to. Set during
		// chunk creation in Phase 2.
		chunkId: text("chunk_id"),
		translation: text("translation").notNull().default("web"),
		sourceVersion: text("source_version").notNull(),
	},
	(t) => [
		index("bv_book_chapter_verse_idx").on(t.bookCode, t.chapter, t.verse),
		index("bv_book_order_idx").on(t.bookOrder),
		index("bv_canon_idx").on(t.canon),
		index("bv_chunk_id_idx").on(t.chunkId),
	],
);

// --- bible_parallels ---
// Pre-computed top-10 nearest neighbors in each direction between UB
// paragraphs and Bible chunks. Direction is stored explicitly because the
// neighbor relation is asymmetric: paragraph A's top 10 verses don't always
// contain Bible chunk B that lists A in its top 10.
//
// `source` is future-proofing for an optional curated layer (e.g., Faw's
// Paramony) that would coexist alongside `source: "semantic"` rows.
//
// `embedding_model` records which model produced the similarity scores so
// re-running the seed after a model upgrade overwrites cleanly via
// ON CONFLICT (...) DO UPDATE.
export const bibleParallels = pgTable(
	"bible_parallels",
	{
		id: serial("id").primaryKey(),
		direction: text("direction").notNull(), // "ub_to_bible" | "bible_to_ub"
		paragraphId: text("paragraph_id")
			.notNull()
			.references(() => paragraphs.id),
		bibleChunkId: text("bible_chunk_id")
			.notNull()
			.references(() => bibleChunks.id),
		similarity: real("similarity").notNull(),
		rank: integer("rank").notNull(),
		source: text("source").notNull().default("semantic"),
		embeddingModel: text("embedding_model").notNull(),
		generatedAt: timestamp("generated_at").notNull().defaultNow(),
	},
	(t) => [
		index("bp_para_direction_rank_idx").on(t.paragraphId, t.direction, t.rank),
		index("bp_bible_direction_rank_idx").on(t.bibleChunkId, t.direction, t.rank),
		uniqueIndex("bp_natural_key_idx").on(t.direction, t.paragraphId, t.bibleChunkId, t.source),
	],
);

// --- urantia_parallels (UB ↔ UB top-10 nearest neighbors) ---
// Naming: `urantiaParallels` mirrors `bibleParallels` — both names describe
// the TARGET type (Urantia paragraphs vs Bible verses). The previous name
// `paragraphParallels` was object-typed (and "paragraph" implicitly meant
// UB throughout this API), which was confusing on first read.
//
// Pre-computed top-10 most-similar Urantia paragraphs per source paragraph.
// Cosine similarity is symmetric in value but the top-K relation is not —
// A's top-10 may not contain B even if B's top-10 contains A — so we
// compute and store both directions naturally (one row per ordered pair).
//
// Self-references are filtered out at compute time; the lowest possible
// rank is 1 (most similar OTHER paragraph).
export const urantiaParallels = pgTable(
	"urantia_parallels",
	{
		id: serial("id").primaryKey(),
		sourceParagraphId: text("source_paragraph_id")
			.notNull()
			.references(() => paragraphs.id),
		targetParagraphId: text("target_paragraph_id")
			.notNull()
			.references(() => paragraphs.id),
		similarity: real("similarity").notNull(),
		rank: integer("rank").notNull(), // 1..10
		// Provenance label (matches `bible_parallels.source`). "semantic" today;
		// reserved for a future curated layer (e.g., Fellowship glossary topic
		// clusters) so the schema can hold both kinds of cross-references side
		// by side without breaking consumers.
		source: text("source").notNull().default("semantic"),
		embeddingModel: text("embedding_model").notNull(),
		generatedAt: timestamp("generated_at").notNull().defaultNow(),
	},
	(t) => [
		index("up_source_rank_idx").on(t.sourceParagraphId, t.rank),
		index("up_target_idx").on(t.targetParagraphId),
		uniqueIndex("up_natural_key_idx").on(t.sourceParagraphId, t.targetParagraphId),
	],
);

// ============================================================
// Auth layer tables (unified auth for the Urantia ecosystem)
// ============================================================

// --- users (synced lazily from Supabase Auth) ---
export const users = pgTable("users", {
	id: uuid("id").primaryKey(), // matches Supabase Auth user ID
	email: text("email").unique(),
	name: text("name"),
	avatarUrl: text("avatar_url"),
	createdAt: timestamp("created_at").notNull().defaultNow(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// --- bookmarks (paragraph-level, one per user + paragraph + app) ---
export const bookmarks = pgTable(
	"bookmarks",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		appId: text("app_id").notNull().default("default"), // which app created this
		paragraphId: text("paragraph_id").notNull(), // globalId e.g. "1:2.0.1"
		paperId: text("paper_id").notNull(), // denormalized
		paperSectionId: text("paper_section_id").notNull(), // denormalized
		paperSectionParagraphId: text("paper_section_paragraph_id").notNull(), // denormalized
		category: text("category"), // user-defined label, nullable
		visibility: text("visibility").notNull().default("private"), // private | public | group (future)
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("bookmarks_user_paragraph_app_idx").on(t.userId, t.paragraphId, t.appId),
		index("bookmarks_user_id_idx").on(t.userId),
		index("bookmarks_user_paper_idx").on(t.userId, t.paperId),
	],
);

// --- notes (paragraph-level, multiple per paragraph allowed) ---
export const notes = pgTable(
	"notes",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		appId: text("app_id").notNull().default("default"),
		paragraphId: text("paragraph_id").notNull(),
		paperId: text("paper_id").notNull(),
		paperSectionId: text("paper_section_id").notNull(),
		paperSectionParagraphId: text("paper_section_paragraph_id").notNull(),
		text: text("text").notNull(),
		format: text("format").notNull().default("plain"), // 'plain' or 'markdown'
		visibility: text("visibility").notNull().default("private"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(t) => [
		index("notes_user_id_idx").on(t.userId),
		index("notes_user_paper_idx").on(t.userId, t.paperId),
		index("notes_user_paragraph_idx").on(t.userId, t.paragraphId),
	],
);

// --- reading_progress (paragraph-level, one per user + paragraph + app) ---
export const readingProgress = pgTable(
	"reading_progress",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		appId: text("app_id").notNull().default("default"),
		paragraphId: text("paragraph_id").notNull(),
		paperId: text("paper_id").notNull(),
		paperSectionId: text("paper_section_id").notNull(),
		paperSectionParagraphId: text("paper_section_paragraph_id").notNull(),
		readAt: timestamp("read_at").notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("reading_progress_user_paragraph_app_idx").on(t.userId, t.paragraphId, t.appId),
		index("reading_progress_user_id_idx").on(t.userId),
		index("reading_progress_user_paper_idx").on(t.userId, t.paperId),
	],
);

// --- user_preferences (flexible JSONB per user) ---
export const userPreferences = pgTable("user_preferences", {
	userId: uuid("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	preferences: pgJsonb("preferences").default({}).notNull(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// --- apps (OAuth client registry) ---
export const apps = pgTable("apps", {
	id: text("id").primaryKey(), // human-readable slug e.g. "urantiahub"
	name: text("name").notNull(),
	secretHash: text("secret_hash").notNull(),
	redirectUris: text("redirect_uris").array().notNull(),
	scopes: text("scopes").array().notNull(),
	ownerId: uuid("owner_id").references(() => users.id),
	logoUrl: text("logo_url"),
	primaryColor: text("primary_color"),
	accentColor: text("accent_color"),
	createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --- user_consents (OAuth consent grants per user per app) ---
export const userConsents = pgTable(
	"user_consents",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		appId: text("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),
		scopes: text("scopes").array().notNull(),
		grantedAt: timestamp("granted_at").notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("user_consents_user_app_idx").on(t.userId, t.appId),
	],
);

// --- app_user_data (sandboxed key-value per app per user) ---
export const appUserData = pgTable(
	"app_user_data",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		appId: text("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		value: pgJsonb("value").notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("app_user_data_app_user_key_idx").on(t.appId, t.userId, t.key),
		index("app_user_data_app_user_idx").on(t.appId, t.userId),
	],
);

// --- refresh_tokens (one-time-use, rotated on each refresh) ---
export const refreshTokens = pgTable(
	"refresh_tokens",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		appId: text("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull(),
		consumed: timestamp("consumed"), // null = active, set = used (kept for theft detection)
		expiresAt: timestamp("expires_at").notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(t) => [
		index("refresh_tokens_user_app_idx").on(t.userId, t.appId),
		index("refresh_tokens_token_hash_idx").on(t.tokenHash),
	],
);

// --- auth_codes (short-lived OAuth authorization codes) ---
export const authCodes = pgTable("auth_codes", {
	code: text("code").primaryKey(),
	appId: text("app_id")
		.notNull()
		.references(() => apps.id, { onDelete: "cascade" }),
	userId: uuid("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	scopes: text("scopes").array().notNull(),
	codeChallenge: text("code_challenge"), // PKCE
	redirectUri: text("redirect_uri").notNull(),
	expiresAt: timestamp("expires_at").notNull(),
});

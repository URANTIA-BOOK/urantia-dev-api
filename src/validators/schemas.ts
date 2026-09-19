import { z } from "zod";

// --- Supported languages ---

export const SupportedLanguage = z
	.string()
	.regex(/^[a-z]{2,8}$/)
	.default("eng");

export const LangQuery = z.object({
	lang: SupportedLanguage.optional(),
	source: z.string().min(1).max(120).optional(),
});

// --- Shared response schemas ---

export const PaginationMeta = z.object({
	page: z.number().int(),
	limit: z.number().int(),
	total: z.number().int(),
	totalPages: z.number().int(),
});

export const ErrorResponse = z.object({
	type: z.string(),
	title: z.string(),
	status: z.number().int(),
	detail: z.string(),
});

// --- Part ---

export const PartSchema = z.object({
	id: z.string(),
	title: z.string(),
	sponsorship: z.string().nullable(),
	sortId: z.string(),
});

// --- Paper ---

// --- Video variant ---

const VideoVariantSchema = z.object({
	mp4: z.string(),
	thumbnail: z.string(),
	duration: z.number(),
});

const VideoSchema = z.record(z.string(), VideoVariantSchema).nullable();

// --- Paper ---

// --- Entity mention (used by paragraphs when ?include=entities, and by
//     paper-level topEntities aggregate) ---

export const EntityMentionSchema = z.object({
	id: z.string(),
	name: z.string(),
	type: z.string(),
});

export const TopEntitySchema = EntityMentionSchema.extend({
	count: z.number().int().nonnegative(),
});

// --- Paper ---

export const PaperSchema = z.object({
	id: z.string(),
	partId: z.string(),
	title: z.string(),
	sortId: z.string(),
	labels: z.array(z.string()).nullable(),
	video: VideoSchema,
	topEntities: z.array(TopEntitySchema).optional(),
});

// --- Section ---

export const SectionSchema = z.object({
	id: z.string(),
	paperId: z.string(),
	sectionId: z.string(),
	title: z.string().nullable(),
	globalId: z.string(),
	sortId: z.string(),
});

// --- Audio variant ---

const AudioVariantSchema = z.object({
	format: z.string(),
	url: z.string(),
	duration: z.number().optional(),
	bitrate: z.number().optional(),
	fileSize: z.number().optional(),
});

const AudioSchema = z
	.record(
		z.string(),
		z.record(z.string(), AudioVariantSchema),
	)
	.nullable();

// --- Paragraph Entity (inline on paragraph when include=entities) ---

export const ParagraphEntitySchema = z.object({
	id: z.string(),
	name: z.string(),
	type: z.enum(["being", "place", "order", "race", "religion", "concept"]),
});

// --- Paragraph Bible parallel (inline on paragraph when include=bibleParallels) ---

export const ParagraphBibleParallelSchema = z.object({
	chunkId: z.string(),
	reference: z.string(),
	bookCode: z.string(),
	chapter: z.number().int(),
	verseStart: z.number().int(),
	verseEnd: z.number().int(),
	text: z.string(),
	similarity: z.number(),
	rank: z.number().int(),
	source: z.string(),
	embeddingModel: z.string(),
});

// --- Urantia parallel (inline on paragraph when include=urantiaParallels) ---
// Top-10 most-similar OTHER UB paragraphs to this one, by cosine similarity
// of text-embedding-3-large vectors.
export const UrantiaParallelSchema = z.object({
	id: z.string(),
	standardReferenceId: z.string(),
	paperId: z.string(),
	paperTitle: z.string(),
	sectionTitle: z.string().nullable(),
	text: z.string(),
	similarity: z.number(),
	rank: z.number().int(),
	source: z.string(),
	embeddingModel: z.string(),
});

// --- Paragraph ---

export const ParagraphSchema = z.object({
	id: z.string(),
	standardReferenceId: z.string(),
	sortId: z.string(),
	paperId: z.string(),
	sectionId: z.string().nullable(),
	partId: z.string(),
	paperTitle: z.string(),
	sectionTitle: z.string().nullable(),
	paragraphId: z.string(),
	text: z.string(),
	htmlText: z.string(),
	language: z.string().optional(),
	labels: z.array(z.string()).nullable(),
	audio: AudioSchema,
	entities: z.array(ParagraphEntitySchema).optional(),
	bibleParallels: z.array(ParagraphBibleParallelSchema).optional(),
	urantiaParallels: z.array(UrantiaParallelSchema).optional(),
});

// --- TOC ---

export const TocPaperSchema = z.object({
	id: z.string(),
	title: z.string(),
	labels: z.array(z.string()).nullable(),
});

export const TocPartSchema = z.object({
	id: z.string(),
	title: z.string(),
	sponsorship: z.string().nullable(),
	papers: z.array(TocPaperSchema),
});

export const TocResponse = z.object({
	data: z.object({
		parts: z.array(TocPartSchema),
	}),
});

// --- Papers list ---

export const PapersListResponse = z.object({
	data: z.array(PaperSchema),
});

// --- Single paper with paragraphs ---

export const PaperDetailResponse = z.object({
	data: z.object({
		paper: PaperSchema,
		paragraphs: z.array(ParagraphSchema),
	}),
});

// --- Sections ---

export const SectionsResponse = z.object({
	data: z.array(SectionSchema),
});

// --- Paragraph ---

export const NavigationSchema = z.object({
	prev: z.string().nullable(),
	next: z.string().nullable(),
});

export const ParagraphResponse = z.object({
	data: ParagraphSchema,
	navigation: NavigationSchema.optional(),
});

// --- RAG format ---

export const RagResponseSchema = z.object({
	data: z.object({
		ref: z.string(),
		text: z.string(),
		citation: z.string(),
		metadata: z.object({
			paperId: z.string(),
			paperTitle: z.string(),
			sectionId: z.string().nullable(),
			sectionTitle: z.string().nullable(),
			partId: z.string(),
			paragraphId: z.string(),
		}),
		navigation: z.object({
			prev: z.string().nullable(),
			next: z.string().nullable(),
		}),
		tokenCount: z.number().int(),
		entities: z.array(z.string()),
	}),
});

// --- Paragraph context ---

export const ParagraphContextResponse = z.object({
	data: z.object({
		target: ParagraphSchema,
		before: z.array(ParagraphSchema),
		after: z.array(ParagraphSchema),
	}),
});

// --- Search ---

export const SearchRequest = z.object({
	q: z.string().min(1).max(500),
	page: z.number().int().min(0).default(0),
	limit: z.number().int().min(1).max(100).default(20),
	paperId: z.string().optional(),
	partId: z.string().optional(),
	type: z.enum(["phrase", "and", "or"]).default("and"),
	include: z.string().optional(),
});

export const SearchQueryParams = z.object({
	q: z.string().min(1).max(500),
	page: z.coerce.number().int().min(0).default(0),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	paperId: z.string().optional(),
	partId: z.string().optional(),
	type: z.enum(["phrase", "and", "or"]).default("and"),
	include: z.string().optional(),
});

export const SearchResultSchema = ParagraphSchema.extend({
	rank: z.number(),
});

export const SearchResponse = z.object({
	data: z.array(SearchResultSchema),
	meta: PaginationMeta,
});

// --- Semantic Search ---

export const SemanticSearchRequest = z.object({
	q: z.string().min(1).max(2000),
	page: z.number().int().min(0).default(0),
	limit: z.number().int().min(1).max(100).default(20),
	paperId: z.string().optional(),
	partId: z.string().optional(),
	include: z.string().optional(),
});

export const SemanticSearchQueryParams = z.object({
	q: z.string().min(1).max(2000),
	page: z.coerce.number().int().min(0).default(0),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	paperId: z.string().optional(),
	partId: z.string().optional(),
	include: z.string().optional(),
});

export const SemanticSearchResultSchema = ParagraphSchema.extend({
	similarity: z.number(),
});

export const SemanticSearchResponse = z.object({
	data: z.array(SemanticSearchResultSchema),
	meta: PaginationMeta,
});

// --- Audio ---

export const AudioResponse = z.object({
	data: z.object({
		id: z.string(),
		audio: AudioSchema,
	}),
});

// --- Param schemas ---

export const PaperIdParam = z.object({
	id: z.string(),
});

export const ParagraphRefParam = z.object({
	ref: z.string(),
});

export const AudioParam = z.object({
	ref: z.string(),
});

export const FormatEnum = z.enum(["default", "rag"]).default("default");

export const ContextQuery = z.object({
	window: z.coerce.number().int().min(1).max(10).default(2),
	include: z.string().optional(),
	format: FormatEnum.optional(),
	lang: SupportedLanguage.optional(),
	source: z.string().min(1).max(120).optional(),
});

export const IncludeQuery = z.object({
	include: z.string().optional(),
	format: FormatEnum.optional(),
	lang: SupportedLanguage.optional(),
	source: z.string().min(1).max(120).optional(),
});

export const RandomQuery = z.object({
	include: z.string().optional(),
	format: FormatEnum.optional(),
	lang: SupportedLanguage.optional(),
	source: z.string().min(1).max(120).optional(),
	minLength: z.coerce.number().int().min(1).optional(),
	maxLength: z.coerce.number().int().min(1).optional(),
});

// --- Entity ---

export const EntitySchema = z.object({
	id: z.string(),
	name: z.string(),
	type: z.enum(["being", "place", "order", "race", "religion", "concept"]),
	aliases: z.array(z.string()).nullable(),
	description: z.string().nullable(),
	seeAlso: z.array(z.string()).nullable(),
	citationCount: z.number().int(),
	language: z.string().optional(),
});

export const EntitiesListQuery = z.object({
	page: z.coerce.number().int().min(0).default(0),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	type: z.enum(["being", "place", "order", "race", "religion", "concept"]).optional(),
	q: z.string().max(200).optional(),
	lang: SupportedLanguage.optional(),
	source: z.string().min(1).max(120).optional(),
});

export const EntityIdParam = z.object({ id: z.string() });

export const EntityParagraphsQuery = z.object({
	page: z.coerce.number().int().min(0).default(0),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	lang: SupportedLanguage.optional(),
	source: z.string().min(1).max(120).optional(),
});

export const EntitiesListResponse = z.object({
	data: z.array(EntitySchema),
	meta: PaginationMeta,
});

export const EntityDetailResponse = z.object({ data: EntitySchema });

export const EntityParagraphsResponse = z.object({
	data: z.array(ParagraphSchema),
	meta: PaginationMeta,
});

// --- Languages ---

export const TranslationSourceSchema = z.object({
	id: z.string(),
	treeSlug: z.string(),
	versionNumber: z.string().nullable(),
	editionNative: z.string().nullable(),
	editionEnglish: z.string().nullable(),
	bookTitle: z.string().nullable(),
	regionCode: z.string().nullable(),
	firstPublished: z.number().int().nullable(),
	copyrightYear: z.number().int().nullable(),
	isPrimary: z.boolean(),
	paragraphCount: z.number().int(),
});

export const LanguageSchema = z.object({
	code: z.string(),
	slug: z.string(),
	bcp47: z.string(),
	name: z.string(),
	uiLabel: z.string(),
	uiLabelEnglish: z.string(),
	entityCount: z.number().int(),
	paragraphCount: z.number().int(),
	sources: z.array(TranslationSourceSchema),
});

export const LanguagesResponse = z.object({
	data: z.array(LanguageSchema),
});

// --- Bible ---

export const BibleCanon = z.enum(["ot", "deuterocanon", "nt"]);

// One Bible verse from the World English Bible (eng-web).
export const BibleVerseSchema = z.object({
	id: z.string(), // OSIS id, e.g. "Gen.1.1"
	reference: z.string(), // display: "Genesis 1:1"
	bookCode: z.string(), // OSIS: "Gen"
	bookName: z.string(),
	bookOrder: z.number().int(),
	canon: BibleCanon,
	chapter: z.number().int(),
	verse: z.number().int(),
	text: z.string(),
	translation: z.string(), // currently always "web"
});

// A book entry in the master books list.
export const BibleBookSchema = z.object({
	bookCode: z.string(),
	bookName: z.string(),
	fullName: z.string(),
	abbr: z.string(),
	bookOrder: z.number().int(),
	canon: BibleCanon,
	chapterCount: z.number().int(),
	verseCount: z.number().int(),
});

// A chapter contains its book metadata plus all of its verses.
export const BibleChapterSchema = z.object({
	bookCode: z.string(),
	bookName: z.string(),
	canon: BibleCanon,
	chapter: z.number().int(),
	verses: z.array(BibleVerseSchema),
});

// Path params.
export const BibleBookParam = z.object({ bookCode: z.string().min(1) });
export const BibleChapterParam = z.object({
	bookCode: z.string().min(1),
	chapter: z.coerce.number().int().min(1),
});
export const BibleVerseParam = z.object({
	bookCode: z.string().min(1),
	chapter: z.coerce.number().int().min(1),
	verse: z.coerce.number().int().min(1),
});

// Response wrappers.
export const BibleBooksResponse = z.object({
	data: z.array(BibleBookSchema),
});
export const BibleBookResponse = z.object({
	data: BibleBookSchema,
});
export const BibleChapterResponse = z.object({
	data: BibleChapterSchema,
});
export const BibleVerseResponse = z.object({
	data: BibleVerseSchema,
});

// Bible semantic search request + response.
// Caps mirror the UB-side semantic search (now both q.max=2000, limit.max=100,
// limit.default=20) so RAG agents and clients can use the same params on
// either endpoint.
export const BibleSemanticSearchRequest = z.object({
	q: z.string().min(1).max(2000),
	page: z.number().int().min(0).default(0),
	limit: z.number().int().min(1).max(100).default(20),
	canon: BibleCanon.optional(),
	bookCode: z.string().min(1).optional(),
	urantiaParallelLimit: z.number().int().min(0).max(10).default(3),
});

// One Urantia paragraph attached to a Bible-side response (search result
// or reverse-query result). Same shape as the inline parallel returned on
// /paragraphs/{ref}?include=urantiaParallels.
const BibleSideUrantiaParallelSchema = z.object({
	id: z.string(),
	standardReferenceId: z.string(),
	paperId: z.string(),
	paperTitle: z.string(),
	sectionTitle: z.string().nullable(),
	text: z.string(),
	similarity: z.number(),
	rank: z.number().int(),
});

export const BibleSemanticSearchResultSchema = z.object({
	id: z.string(),
	reference: z.string(),
	bookCode: z.string(),
	bookName: z.string(),
	canon: BibleCanon,
	chapter: z.number().int(),
	verseStart: z.number().int(),
	verseEnd: z.number().int(),
	text: z.string(),
	similarity: z.number(),
	urantiaParallels: z.array(BibleSideUrantiaParallelSchema),
});

export const BibleSemanticSearchResponse = z.object({
	data: z.array(BibleSemanticSearchResultSchema),
	meta: PaginationMeta,
});

// Reverse-query: given a Bible verse, list the top-N UB paragraphs
// semantically nearest to the chunk that verse belongs to.
export const BibleVerseUrantiaParallelSchema = z.object({
	id: z.string(), // paragraph globalId
	standardReferenceId: z.string(),
	paperId: z.string(),
	paperTitle: z.string(),
	sectionTitle: z.string().nullable(),
	text: z.string(),
	similarity: z.number(),
	rank: z.number().int(),
	source: z.string(),
	embeddingModel: z.string(),
});
export const BibleVerseParagraphsResponse = z.object({
	data: z.object({
		verse: BibleVerseSchema,
		chunk: z.object({
			id: z.string(),
			reference: z.string(),
			verseStart: z.number().int(),
			verseEnd: z.number().int(),
			text: z.string(),
		}),
		urantiaParallels: z.array(BibleVerseUrantiaParallelSchema),
	}),
});

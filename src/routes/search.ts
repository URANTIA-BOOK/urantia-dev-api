import { createRoute } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
// biome-ignore lint: Handler context type varies per route; using `any` avoids
// duplicating the full typed-response signature for each GET/POST pair.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyContext = any;
import OpenAI from "openai";
import { getDb } from "../db/client.ts";
import { paragraphs } from "../db/schema.ts";
import { createApp } from "../lib/app.ts";
import { enrichWithBibleParallels, wantsBibleParallels } from "../lib/bible-parallels.ts";
import { enrichWithEntities, wantsEntities } from "../lib/entities.ts";
import { problemJson } from "../lib/errors.ts";
import {
	getCachedCount,
	getCachedEmbedding,
	runAfter,
	setCachedCount,
	setCachedEmbedding,
} from "../lib/search-cache.ts";
import {
	enrichWithUrantiaParallels,
	wantsUrantiaParallels,
} from "../lib/urantia-parallels.ts";
import {
	ErrorResponse,
	SearchQueryParams,
	SearchRequest,
	SearchResponse,
	SemanticSearchQueryParams,
	SemanticSearchRequest,
	SemanticSearchResponse,
} from "../validators/schemas.ts";

export const searchRoute = createApp();

/**
 * Build a tsquery string from the search input based on the search type.
 */
function buildTsQuery(sanitized: string, type: "phrase" | "and" | "or"): string {
	switch (type) {
		case "phrase":
			return `phraseto_tsquery('english', '${sanitized}')`;
		case "and": {
			const words = sanitized.split(/\s+/).filter(Boolean);
			return `to_tsquery('english', '${words.join(" & ")}')`;
		}
		case "or": {
			const words = sanitized.split(/\s+/).filter(Boolean);
			return `to_tsquery('english', '${words.join(" | ")}')`;
		}
	}
}

// ── Shared handler: Full-text search ──

type SearchParams = {
	q: string;
	page: number;
	limit: number;
	paperId?: string;
	partId?: string;
	type: "phrase" | "and" | "or";
	include?: string;
};

async function handleFullTextSearch(c: AnyContext, params: SearchParams) {
	const { db } = getDb(c.env?.HYPERDRIVE);
	const { q, page, limit, paperId, partId, type, include } = params;

	if (!q) {
		return problemJson(c, 400, "Search query cannot be empty");
	}

	const sanitized = q.replace(/[^\w\s]/g, " ").trim();

	if (!sanitized) {
		return problemJson(c, 400, "Search query cannot be empty");
	}

	const tsQuery = buildTsQuery(sanitized, type);
	const offset = page * limit;

	// Build WHERE conditions
	const conditions = [sql`search_vector @@ ${sql.raw(tsQuery)}`];

	if (paperId) {
		conditions.push(eq(paragraphs.paperId, paperId));
	}
	if (partId) {
		conditions.push(eq(paragraphs.partId, partId));
	}

	const whereClause = and(...conditions);

	// Count total matches
	const countResult = await db
		.select({ count: sql<number>`count(*)` })
		.from(paragraphs)
		.where(whereClause);

	const total = Number(countResult[0]?.count ?? 0);

	// Fetch results with rank and highlighted text
	const results = await db
		.select({
			id: paragraphs.id,
			standardReferenceId: paragraphs.standardReferenceId,
			sortId: paragraphs.sortId,
			paperId: paragraphs.paperId,
			sectionId: sql<
				string | null
			>`CASE WHEN ${paragraphs.sectionId} IS NOT NULL THEN split_part(${paragraphs.sectionId}, '.', 2) ELSE NULL END`.as(
				"sectionId",
			),
			partId: paragraphs.partId,
			paperTitle: paragraphs.paperTitle,
			sectionTitle: paragraphs.sectionTitle,
			paragraphId: paragraphs.paragraphId,
			text: paragraphs.text,
			htmlText: sql<string>`ts_headline('english', ${paragraphs.htmlText}, ${sql.raw(tsQuery)}, ${sql.raw('\'StartSel="<span class=urantia-dev-highlighted>", StopSel="</span>", MaxFragments=0, HighlightAll=true\'')})`,
			labels: paragraphs.labels,
			audio: paragraphs.audio,
			rank: sql<number>`ts_rank(search_vector, ${sql.raw(tsQuery)})`,
		})
		.from(paragraphs)
		.where(whereClause)
		.orderBy(sql`ts_rank(search_vector, ${sql.raw(tsQuery)}) DESC`)
		.limit(limit)
		.offset(offset);

	const logger = c.get("logger");
	if (logger) {
		logger.info("search", {
			query: q,
			search_type: type,
			paper_id: paperId ?? undefined,
			part_id: partId ?? undefined,
			result_count: total,
		});
	}

	type Enriched = (typeof results)[number] & {
		entities?: Awaited<ReturnType<typeof enrichWithEntities>>[number]["entities"];
		bibleParallels?: Awaited<ReturnType<typeof enrichWithBibleParallels>>[number]["bibleParallels"];
		urantiaParallels?: Awaited<ReturnType<typeof enrichWithUrantiaParallels>>[number]["urantiaParallels"];
	};
	let enrichedResults: Enriched[] = results;
	if (wantsEntities(include))
		enrichedResults = (await enrichWithEntities(db, enrichedResults)) as Enriched[];
	if (wantsBibleParallels(include))
		enrichedResults = (await enrichWithBibleParallels(db, enrichedResults)) as Enriched[];
	if (wantsUrantiaParallels(include))
		enrichedResults = (await enrichWithUrantiaParallels(db, enrichedResults)) as Enriched[];

	return c.json(
		{
			data: enrichedResults,
			meta: {
				page,
				limit,
				total,
				totalPages: Math.ceil(total / limit),
			},
		},
		200,
	);
}

// ── Shared handler: Semantic search ──

type SemanticSearchParams = {
	q: string;
	page: number;
	limit: number;
	paperId?: string;
	partId?: string;
	include?: string;
};

async function handleSemanticSearch(c: AnyContext, params: SemanticSearchParams) {
	const startTotal = performance.now();

	const { db } = getDb(c.env?.HYPERDRIVE);
	const kv = c.env?.SEARCH_CACHE as KVNamespace | undefined;
	const { q, page, limit, paperId, partId, include } = params;

	if (!q) {
		return problemJson(c, 400, "Search query cannot be empty");
	}

	const offset = page * limit;

	const startEmbedding = performance.now();
	let queryVector = await getCachedEmbedding(kv, q);
	const embeddingCacheHit = queryVector !== null;
	if (!queryVector) {
		const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
		const embeddingResponse = await openai.embeddings.create({
			model: "text-embedding-3-small",
			input: q,
		});
		const vec = embeddingResponse.data[0]?.embedding;
		if (!vec) {
			return problemJson(c, 500, "Failed to generate embedding");
		}
		queryVector = vec;
		runAfter(c, setCachedEmbedding(kv, q, vec));
	}
	const embeddingMs = Math.round(performance.now() - startEmbedding);
	const vectorStr = `[${queryVector.join(",")}]`;

	// Build WHERE conditions
	const conditions = [sql`embedding IS NOT NULL`];
	if (paperId) {
		conditions.push(eq(paragraphs.paperId, paperId));
	}
	if (partId) {
		conditions.push(eq(paragraphs.partId, partId));
	}
	const whereClause = and(...conditions);

	// Run count (if not cached) and vector search in parallel.
	const startQueries = performance.now();
	const cachedCount = await getCachedCount(kv, paperId, partId);
	const countCacheHit = cachedCount !== null;
	const countPromise = countCacheHit
		? Promise.resolve<{ count: number }[]>([{ count: cachedCount }])
		: db.select({ count: sql<number>`count(*)` }).from(paragraphs).where(whereClause);
	const [countResult, results] = await Promise.all([
		countPromise,
		db
			.select({
				id: paragraphs.id,
				standardReferenceId: paragraphs.standardReferenceId,
				sortId: paragraphs.sortId,
				paperId: paragraphs.paperId,
				sectionId: sql<
					string | null
				>`CASE WHEN ${paragraphs.sectionId} IS NOT NULL THEN split_part(${paragraphs.sectionId}, '.', 2) ELSE NULL END`.as(
					"sectionId",
				),
				partId: paragraphs.partId,
				paperTitle: paragraphs.paperTitle,
				sectionTitle: paragraphs.sectionTitle,
				paragraphId: paragraphs.paragraphId,
				text: paragraphs.text,
				htmlText: paragraphs.htmlText,
				labels: paragraphs.labels,
				audio: paragraphs.audio,
				similarity: sql<number>`1 - (embedding <=> ${vectorStr}::vector)`,
			})
			.from(paragraphs)
			.where(whereClause)
			.orderBy(sql`embedding <=> ${vectorStr}::vector`)
			.limit(limit)
			.offset(offset),
	]);
	const queriesMs = Math.round(performance.now() - startQueries);

	const total = Number(countResult[0]?.count ?? 0);
	if (!countCacheHit) {
		runAfter(c, setCachedCount(kv, paperId, partId, total));
	}

	type Enriched = (typeof results)[number] & {
		entities?: Awaited<ReturnType<typeof enrichWithEntities>>[number]["entities"];
		bibleParallels?: Awaited<ReturnType<typeof enrichWithBibleParallels>>[number]["bibleParallels"];
		urantiaParallels?: Awaited<ReturnType<typeof enrichWithUrantiaParallels>>[number]["urantiaParallels"];
	};
	let enrichMs = 0;
	let enrichedResults: Enriched[] = results;
	const startEnrich = performance.now();
	if (wantsEntities(include))
		enrichedResults = (await enrichWithEntities(db, enrichedResults)) as Enriched[];
	if (wantsBibleParallels(include))
		enrichedResults = (await enrichWithBibleParallels(db, enrichedResults)) as Enriched[];
	if (wantsUrantiaParallels(include))
		enrichedResults = (await enrichWithUrantiaParallels(db, enrichedResults)) as Enriched[];
	if (wantsEntities(include) || wantsBibleParallels(include) || wantsUrantiaParallels(include)) {
		enrichMs = Math.round(performance.now() - startEnrich);
	}

	const totalMs = Math.round(performance.now() - startTotal);

	const logger = c.get("logger");
	if (logger) {
		logger.info("semantic_search", {
			query: q,
			paper_id: paperId ?? undefined,
			part_id: partId ?? undefined,
			result_count: total,
			cache: {
				embedding_hit: embeddingCacheHit,
				count_hit: countCacheHit,
			},
			timing: {
				embedding_ms: embeddingMs,
				db_queries_ms: queriesMs,
				enrichment_ms: enrichMs,
				total_ms: totalMs,
			},
		});
	}

	return c.json(
		{
			data: enrichedResults,
			meta: {
				page,
				limit,
				total,
				totalPages: Math.ceil(total / limit),
			},
		},
		200,
	);
}

// ── Route definitions ──

const searchDescription = `Search the Urantia Papers using full-text search. Supports three search modes:
- **and**: All words must appear (default)
- **or**: Any word can appear
- **phrase**: Exact phrase match

Results are ranked by relevance. Optional filters: paperId, partId.`;

const searchResponses = {
	200: {
		description: "Search results with pagination",
		content: { "application/json": { schema: SearchResponse } },
	},
	400: {
		description: "Invalid search query",
		content: { "application/json": { schema: ErrorResponse } },
	},
	500: {
		description: "Internal server error",
		content: { "application/json": { schema: ErrorResponse } },
	},
};

const semanticSearchDescription = `Search the Urantia Papers using semantic similarity (vector embeddings).
Returns conceptually related results even without exact keyword matches.
Optional filters: paperId, partId.`;

const semanticSearchResponses = {
	200: {
		description: "Semantic search results with pagination",
		content: { "application/json": { schema: SemanticSearchResponse } },
	},
	400: {
		description: "Invalid search query",
		content: { "application/json": { schema: ErrorResponse } },
	},
	500: {
		description: "Internal server error",
		content: { "application/json": { schema: ErrorResponse } },
	},
};

// ── POST /search ──

const searchPostRoute = createRoute({
	operationId: "search",
	method: "post",
	path: "/",
	tags: ["Search"],
	summary: "Full-text search across all paragraphs",
	description: searchDescription,
	request: {
		body: {
			required: true,
			content: { "application/json": { schema: SearchRequest } },
		},
	},
	responses: searchResponses,
});

searchRoute.openapi(searchPostRoute, async (c) => {
	const params = c.req.valid("json");
	// Accept ?include=... on POST as a fallback so callers who default to
	// putting opt-in flags in the URL still get enrichment.
	return handleFullTextSearch(c, { ...params, include: params.include ?? c.req.query("include") });
});

// ── GET /search ──

const searchGetRoute = createRoute({
	operationId: "searchGet",
	method: "get",
	path: "/",
	tags: ["Search"],
	summary: "Full-text search across all paragraphs (GET)",
	description: `${searchDescription}\n\nAccepts query parameters instead of a JSON body. Designed for AI agents and browser-based access.`,
	request: {
		query: SearchQueryParams,
	},
	responses: searchResponses,
});

searchRoute.openapi(searchGetRoute, async (c) => {
	const params = c.req.valid("query");
	return handleFullTextSearch(c, params);
});

// ── POST /search/semantic ──

const semanticSearchPostRoute = createRoute({
	operationId: "semanticSearch",
	method: "post",
	path: "/semantic",
	tags: ["Search"],
	summary: "Semantic similarity search across all paragraphs",
	description: semanticSearchDescription,
	request: {
		body: {
			required: true,
			content: { "application/json": { schema: SemanticSearchRequest } },
		},
	},
	responses: semanticSearchResponses,
});

searchRoute.openapi(semanticSearchPostRoute, async (c) => {
	const params = c.req.valid("json");
	return handleSemanticSearch(c, { ...params, include: params.include ?? c.req.query("include") });
});

// ── GET /search/semantic ──

const semanticSearchGetRoute = createRoute({
	operationId: "semanticSearchGet",
	method: "get",
	path: "/semantic",
	tags: ["Search"],
	summary: "Semantic similarity search across all paragraphs (GET)",
	description: `${semanticSearchDescription}\n\nAccepts query parameters instead of a JSON body. Designed for AI agents and browser-based access.`,
	request: {
		query: SemanticSearchQueryParams,
	},
	responses: semanticSearchResponses,
});

searchRoute.openapi(semanticSearchGetRoute, async (c) => {
	const params = c.req.valid("query");
	return handleSemanticSearch(c, params);
});

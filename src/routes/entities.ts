import { createRoute } from "@hono/zod-openapi";
import { and, eq, ilike, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { entities, paragraphEntities, paragraphs } from "../db/schema.ts";
import { createApp } from "../lib/app.ts";
import { problemJson } from "../lib/errors.ts";
import { applyEntityTranslations, applyParagraphTranslations, applyTitleTranslations } from "../lib/translations.ts";
import { paragraphFields } from "./paragraphs.ts";
import {
	EntitiesListQuery,
	EntitiesListResponse,
	EntityDetailResponse,
	EntityIdParam,
	EntityParagraphsQuery,
	EntityParagraphsResponse,
	ErrorResponse,
} from "../validators/schemas.ts";

export const entitiesRoute = createApp();

// GET /entities — list/browse entities
const listEntitiesRoute = createRoute({
	operationId: "listEntities",
	method: "get",
	path: "/",
	tags: ["Entities"],
	summary: "List entities",
	description:
		"Browse the entity catalog (beings, places, orders, races, religions, concepts). Supports filtering by type and searching by name.",
	request: {
		query: EntitiesListQuery,
	},
	responses: {
		200: {
			description: "Paginated list of entities",
			content: { "application/json": { schema: EntitiesListResponse } },
		},
		500: {
			description: "Internal server error",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

entitiesRoute.openapi(listEntitiesRoute, async (c) => {
	const { db } = getDb(c.env?.HYPERDRIVE);
	const { page, limit, type, q, lang } = c.req.valid("query");
	const offset = page * limit;

	const conditions = [];

	if (type) {
		conditions.push(eq(entities.type, type));
	}

	if (q) {
		conditions.push(
			sql`(${ilike(entities.name, `%${q}%`)} OR array_to_string(${entities.aliases}, ',') ILIKE ${`%${q}%`})`,
		);
	}

	const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

	const countResult = await db
		.select({ count: sql<number>`count(*)` })
		.from(entities)
		.where(whereClause);

	const total = Number(countResult[0]?.count ?? 0);

	const results = await db
		.select({
			id: entities.id,
			name: entities.name,
			type: entities.type,
			aliases: entities.aliases,
			description: entities.description,
			seeAlso: entities.seeAlso,
			citationCount: entities.citationCount,
		})
		.from(entities)
		.where(whereClause)
		.orderBy(entities.name)
		.limit(limit)
		.offset(offset);



	// Apply entity translations if lang specified
	const translatedResults = (lang && lang !== "eng")
		? await applyEntityTranslations(db, results, lang)
		: results;

	return c.json(
		{
			data: translatedResults,
			meta: {
				page,
				limit,
				total,
				totalPages: Math.ceil(total / limit),
			},
		},
		200,
	);
});

// GET /entities/:id — single entity
const getEntityRoute = createRoute({
	operationId: "getEntity",
	method: "get",
	path: "/{id}",
	tags: ["Entities"],
	summary: "Get an entity by ID",
	description: "Returns a single entity by its slug ID.",
	request: {
		params: EntityIdParam,
	},
	responses: {
		200: {
			description: "The entity",
			content: { "application/json": { schema: EntityDetailResponse } },
		},
		404: {
			description: "Entity not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		500: {
			description: "Internal server error",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

entitiesRoute.openapi(getEntityRoute, async (c) => {
	const { db } = getDb(c.env?.HYPERDRIVE);
	const { id } = c.req.valid("param");

	const result = await db
		.select({
			id: entities.id,
			name: entities.name,
			type: entities.type,
			aliases: entities.aliases,
			description: entities.description,
			seeAlso: entities.seeAlso,
			citationCount: entities.citationCount,
		})
		.from(entities)
		.where(eq(entities.id, id))
		.limit(1);

	if (result.length === 0) {
		return problemJson(c, 404, `Entity "${id}" not found`);
	}

	// Note: getEntity doesn't have a query schema with lang, so we read it manually
	const lang = c.req.query("lang");
	const data = (lang && lang !== "eng")
		? (await applyEntityTranslations(db, result, lang))[0]!
		: result[0]!;

	return c.json({ data }, 200);
});

// GET /entities/:id/paragraphs — paragraphs mentioning entity
const getEntityParagraphsRoute = createRoute({
	operationId: "getEntityParagraphs",
	method: "get",
	path: "/{id}/paragraphs",
	tags: ["Entities"],
	summary: "Get paragraphs mentioning an entity",
	description:
		"Returns all paragraphs that mention a given entity, ordered by position in the text.",
	request: {
		params: EntityIdParam,
		query: EntityParagraphsQuery,
	},
	responses: {
		200: {
			description: "Paginated paragraphs mentioning the entity",
			content: { "application/json": { schema: EntityParagraphsResponse } },
		},
		404: {
			description: "Entity not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		500: {
			description: "Internal server error",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

entitiesRoute.openapi(getEntityParagraphsRoute, async (c) => {
	const { db } = getDb(c.env?.HYPERDRIVE);
	const { id } = c.req.valid("param");
	const { page, limit, lang, source } = c.req.valid("query");
	const offset = page * limit;

	// Verify entity exists
	const entity = await db
		.select({ id: entities.id })
		.from(entities)
		.where(eq(entities.id, id))
		.limit(1);

	if (entity.length === 0) {
	
		return problemJson(c, 404, `Entity "${id}" not found`);
	}

	// Count total paragraphs for this entity
	const countResult = await db
		.select({ count: sql<number>`count(*)` })
		.from(paragraphEntities)
		.where(eq(paragraphEntities.entityId, id));

	const total = Number(countResult[0]?.count ?? 0);

	// Fetch paragraphs via junction table
	const results = await db
		.select(paragraphFields)
		.from(paragraphs)
		.innerJoin(paragraphEntities, eq(paragraphs.id, paragraphEntities.paragraphId))
		.where(eq(paragraphEntities.entityId, id))
		.orderBy(paragraphs.sortId)
		.limit(limit)
		.offset(offset);



	// Apply paragraph translations if lang specified
	const translatedResults =
		(lang && lang !== "eng") || source
			? await applyParagraphTranslations(db, results, lang ?? "eng", source)
			: results;

	return c.json(
		{
			data: translatedResults,
			meta: {
				page,
				limit,
				total,
				totalPages: Math.ceil(total / limit),
			},
		},
		200,
	);
});

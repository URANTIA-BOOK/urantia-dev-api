import { createRoute } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import {
	entityTranslations,
	languages,
	paragraphs,
	paragraphTranslations,
	translationSources,
} from "../db/schema.ts";
import { createApp } from "../lib/app.ts";
import { ErrorResponse, LanguagesResponse } from "../validators/schemas.ts";

export const languagesRoute = createApp();

const listLanguagesRoute = createRoute({
	operationId: "listLanguages",
	method: "get",
	path: "/",
	tags: ["Languages"],
	summary: "List available languages",
	description:
		"Returns seeded languages and their translation sources, with paragraph and entity counts.",
	responses: {
		200: {
			description: "Available languages with sources and counts",
			content: { "application/json": { schema: LanguagesResponse } },
		},
		500: {
			description: "Internal server error",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

languagesRoute.openapi(listLanguagesRoute, async (c) => {
	const { db } = getDb(c.env?.HYPERDRIVE);

	const langRows = await db
		.select()
		.from(languages)
		.orderBy(languages.sortId);

	const sourceRows = await db.select().from(translationSources);

	const entityCounts = await db
		.select({
			language: entityTranslations.language,
			count: sql<number>`count(DISTINCT ${entityTranslations.entityId})`,
		})
		.from(entityTranslations)
		.groupBy(entityTranslations.language);

	const paragraphCounts = await db
		.select({
			sourceId: paragraphTranslations.sourceId,
			count: sql<number>`count(*)`,
		})
		.from(paragraphTranslations)
		.groupBy(paragraphTranslations.sourceId);

	const [englishRow] = await db
		.select({ count: sql<number>`count(*)` })
		.from(paragraphs);

	const entityMap = new Map(entityCounts.map((e) => [e.language, Number(e.count)]));
	const paraBySource = new Map(
		paragraphCounts.map((p) => [p.sourceId, Number(p.count)]),
	);
	const englishCount = Number(englishRow?.count ?? 0);

	const data = langRows.map((lang) => {
		const sources = sourceRows
			.filter((source) => source.languageCode === lang.code)
			.map((source) => {
				const paragraphCount =
					lang.code === "eng" && paraBySource.get(source.id) == null
						? englishCount
						: (paraBySource.get(source.id) ?? 0);
				return {
					id: source.id,
					treeSlug: source.treeSlug,
					versionNumber: source.versionNumber,
					editionNative: source.editionNative,
					editionEnglish: source.editionEnglish,
					bookTitle: source.bookTitle,
					regionCode: source.regionCode,
					firstPublished: source.firstPublished,
					copyrightYear: source.copyrightYear,
					isPrimary: source.isPrimary,
					paragraphCount,
				};
			})
			.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
		const primary = sources.find((source) => source.isPrimary);
		const overlayCount = sources.reduce((sum, source) => sum + source.paragraphCount, 0);
		return {
			code: lang.code,
			slug: lang.slug,
			bcp47: lang.bcp47,
			name: lang.uiLabel,
			uiLabel: lang.uiLabel,
			uiLabelEnglish: lang.uiLabelEnglish,
			entityCount: entityMap.get(lang.code) ?? 0,
			paragraphCount:
				lang.code === "eng" ? englishCount : (primary?.paragraphCount ?? overlayCount),
			sources,
		};
	});

	return c.json({ data }, 200);
});

/**
 * translations.ts — Shared helpers for overlaying translations onto query results
 */

import { eq, and, or, sql } from "drizzle-orm";
import {
	paragraphTranslations,
	entityTranslations,
	titleTranslations,
	translationSources,
	languages,
} from "../db/schema.ts";

async function resolveApiLang(db: any, lang: string): Promise<string> {
	if (!lang) return "eng";
	const rows = await db
		.select({ code: languages.code })
		.from(languages)
		.where(or(eq(languages.code, lang), eq(languages.slug, lang)))
		.limit(1);
	return rows[0]?.code ?? lang;
}

/**
 * Resolve which translation_sources row to overlay.
 * `?source=` wins when it exists; otherwise the language's primary edition.
 */
async function resolveOverlaySource(
	db: any,
	lang: string,
	source?: string | null,
): Promise<{ apiLang: string; sourceId: string | null }> {
	const wanted = source?.trim();
	if (wanted) {
		const rows = await db
			.select({
				id: translationSources.id,
				languageCode: translationSources.languageCode,
			})
			.from(translationSources)
			.where(eq(translationSources.id, wanted))
			.limit(1);
		if (rows[0]) {
			return { apiLang: rows[0].languageCode, sourceId: rows[0].id };
		}
	}

	const apiLang = await resolveApiLang(db, lang);
	if (!apiLang || apiLang === "eng") {
		return { apiLang: "eng", sourceId: null };
	}

	const primary = await db
		.select({ id: translationSources.id })
		.from(translationSources)
		.where(
			and(
				eq(translationSources.languageCode, apiLang),
				eq(translationSources.isPrimary, true),
			),
		)
		.limit(1);
	return { apiLang, sourceId: primary[0]?.id ?? null };
}

/**
 * Overlay translated text/htmlText onto paragraph results.
 * Uses `?source=` when set, otherwise the primary translation_source.
 * Falls back to English with `language: "eng"`.
 */
export async function applyParagraphTranslations<T extends { id: string; text: string; htmlText: string }>(
	db: any,
	paragraphs: T[],
	lang: string,
	source?: string | null,
): Promise<(T & { language: string })[]> {
	if ((!lang && !source) || paragraphs.length === 0) {
		return paragraphs.map((p) => ({ ...p, language: "eng" }));
	}

	const overlay = await resolveOverlaySource(db, lang, source);
	if (!overlay.sourceId || overlay.apiLang === "eng") {
		return paragraphs.map((p) => ({ ...p, language: "eng" }));
	}

	const paraIds = paragraphs.map((p) => p.id);
	const translations = await db
		.select({
			paragraphId: paragraphTranslations.paragraphId,
			text: paragraphTranslations.text,
			htmlText: paragraphTranslations.htmlText,
		})
		.from(paragraphTranslations)
		.where(
			and(
				sql`${paragraphTranslations.paragraphId} IN (${sql.join(paraIds.map((id) => sql`${id}`), sql`, `)})`,
				eq(paragraphTranslations.sourceId, overlay.sourceId),
			),
		);

	const translationMap = new Map(
		// biome-ignore lint: Drizzle select result type
		translations.map((t: any) => [t.paragraphId, t]),
	);

	return paragraphs.map((p) => {
		const translation = translationMap.get(p.id) as { text: string; htmlText: string } | undefined;
		if (translation) {
			return { ...p, text: translation.text, htmlText: translation.htmlText, language: overlay.apiLang };
		}
		return { ...p, language: "eng" };
	});
}

/**
 * Overlay translated name/aliases/description onto entity results.
 */
export async function applyEntityTranslations<T extends { id: string; name: string; aliases: string[] | null; description: string | null }>(
	db: any,
	entities: T[],
	lang: string,
): Promise<(T & { language: string })[]> {
	if (!lang || lang === "eng" || entities.length === 0) {
		return entities.map((e) => ({ ...e, language: "eng" }));
	}

	const apiLang = await resolveApiLang(db, lang);
	const entityIds = entities.map((e) => e.id);
	const translations = await db
		.select({
			entityId: entityTranslations.entityId,
			name: entityTranslations.name,
			aliases: entityTranslations.aliases,
			description: entityTranslations.description,
		})
		.from(entityTranslations)
		.where(
			and(
				sql`${entityTranslations.entityId} IN (${sql.join(entityIds.map((id) => sql`${id}`), sql`, `)})`,
				eq(entityTranslations.language, apiLang),
			),
		);

	const translationMap = new Map(
		// biome-ignore lint: Drizzle select result type
		translations.map((t: any) => [t.entityId, t]),
	);

	return entities.map((e) => {
		const translation = translationMap.get(e.id) as { name: string; aliases: string[] | null; description: string | null } | undefined;
		if (translation) {
			return {
				...e,
				name: translation.name,
				aliases: translation.aliases,
				description: translation.description,
				language: apiLang,
			};
		}
		return { ...e, language: "eng" };
	});
}

/**
 * Overlay translated paper/section titles onto results that have paperTitle/sectionTitle.
 */
export async function applyTitleTranslations<T extends { paperId: string; paperTitle: string; sectionId?: string | null; sectionTitle: string | null }>(
	db: any,
	paragraphs: T[],
	lang: string,
	source?: string | null,
): Promise<T[]> {
	if ((!lang && !source) || paragraphs.length === 0) {
		return paragraphs;
	}

	const overlay = await resolveOverlaySource(db, lang, source);
	if (!overlay.sourceId || overlay.apiLang === "eng") {
		return paragraphs;
	}
	const paperIds = [...new Set(paragraphs.map((p) => p.paperId))];
	const sectionIds = [
		...new Set(
			paragraphs.map((p) =>
				p.sectionId ? `${p.paperId}.${p.sectionId}` : null,
			),
		),
	].filter((id): id is string => Boolean(id));
	const sourceIds = [...paperIds, ...sectionIds];
	if (sourceIds.length === 0) return paragraphs;

	const translations = await db
		.select({
			sourceType: titleTranslations.sourceType,
			sourceId: titleTranslations.sourceId,
			title: titleTranslations.title,
		})
		.from(titleTranslations)
		.where(
			and(
				sql`${titleTranslations.sourceId} IN (${sql.join(sourceIds.map((id) => sql`${id}`), sql`, `)})`,
				eq(titleTranslations.translationSourceId, overlay.sourceId),
			),
		);

	const titleMap = new Map(
		// biome-ignore lint: Drizzle select result type
		translations.map((t: any) => [`${t.sourceType}:${t.sourceId}`, t.title]),
	);

	return paragraphs.map((p) => {
		const paperTitle = titleMap.get(`paper:${p.paperId}`) ?? p.paperTitle;
		const sectionKey = p.sectionId ? `section:${p.paperId}.${p.sectionId}` : null;
		const sectionTitle = sectionKey
			? (titleMap.get(sectionKey) ?? p.sectionTitle)
			: p.sectionTitle;
		return { ...p, paperTitle, sectionTitle };
	});
}

export type PartOverlay = {
	sourceType: string;
	sourceId: string;
	title: string;
};

export function mergePartOverlays<
	T extends { id: string; title: string; sponsorship: string | null },
>(partRows: T[], overlays: PartOverlay[]): T[] {
	if (overlays.length === 0) return partRows;
	const titles = new Map<string, string>();
	const sponsorships = new Map<string, string>();
	for (const overlay of overlays) {
		if (overlay.sourceType === "part") titles.set(overlay.sourceId, overlay.title);
		if (overlay.sourceType === "partSponsorship") {
			sponsorships.set(overlay.sourceId, overlay.title);
		}
	}
	return partRows.map((part) => {
		const title = titles.get(part.id);
		const sponsorship = sponsorships.get(part.id);
		if (!title && sponsorship === undefined) return part;
		return {
			...part,
			...(title ? { title } : {}),
			...(sponsorship !== undefined ? { sponsorship } : {}),
		};
	});
}

/**
 * Overlay language-tree part titles and sponsorship onto TOC part rows.
 */
export async function applyPartOverlays<
	T extends { id: string; title: string; sponsorship: string | null },
>(db: any, partRows: T[], lang: string, source?: string | null): Promise<T[]> {
	if ((!lang && !source) || partRows.length === 0) {
		return partRows;
	}
	const overlay = await resolveOverlaySource(db, lang, source);
	if (!overlay.sourceId || overlay.apiLang === "eng") {
		return partRows;
	}
	const partIds = partRows.map((part) => part.id);
	const translations = await db
		.select({
			sourceType: titleTranslations.sourceType,
			sourceId: titleTranslations.sourceId,
			title: titleTranslations.title,
		})
		.from(titleTranslations)
		.where(
			and(
				sql`${titleTranslations.sourceId} IN (${sql.join(partIds.map((id) => sql`${id}`), sql`, `)})`,
				eq(titleTranslations.translationSourceId, overlay.sourceId),
				sql`${titleTranslations.sourceType} IN ('part', 'partSponsorship')`,
			),
		);
	return mergePartOverlays(partRows, translations as PartOverlay[]);
}

/**
 * Overlay translated paper titles onto paper rows (TOC / paper list).
 */
export async function applyPaperTitles<T extends { id: string; title: string }>(
	db: any,
	paperRows: T[],
	lang: string,
	source?: string | null,
): Promise<T[]> {
	if ((!lang && !source) || paperRows.length === 0) {
		return paperRows;
	}
	const translated = await applyTitleTranslations(
		db,
		paperRows.map((paper) => ({
			paperId: paper.id,
			paperTitle: paper.title,
			sectionId: null,
			sectionTitle: null,
		})),
		lang,
		source,
	);
	const titles = new Map(translated.map((row) => [row.paperId, row.paperTitle]));
	return paperRows.map((paper) => {
		const title = titles.get(paper.id);
		return title ? { ...paper, title } : paper;
	});
}

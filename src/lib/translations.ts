/**
 * translations.ts — Shared helpers for overlaying translations onto query results
 */

import { eq, and, sql } from "drizzle-orm";
import {
	paragraphTranslations,
	entityTranslations,
	titleTranslations,
} from "../db/schema.ts";

/**
 * Overlay translated text/htmlText onto paragraph results.
 * Returns the original paragraph with `text`, `htmlText`, and `language` replaced
 * if a translation exists. Falls back to English with `language: "eng"`.
 */
export async function applyParagraphTranslations<T extends { id: string; text: string; htmlText: string }>(
	db: any,
	paragraphs: T[],
	lang: string,
): Promise<(T & { language: string })[]> {
	if (!lang || lang === "eng" || paragraphs.length === 0) {
		return paragraphs.map((p) => ({ ...p, language: "eng" }));
	}

	// Batch-fetch translations for all paragraph IDs
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
				eq(paragraphTranslations.language, lang),
			),
		);

	const translationMap = new Map(
		// biome-ignore lint: Drizzle select result type
		translations.map((t: any) => [t.paragraphId, t]),
	);

	return paragraphs.map((p) => {
		const translation = translationMap.get(p.id) as { text: string; htmlText: string } | undefined;
		if (translation) {
			return { ...p, text: translation.text, htmlText: translation.htmlText, language: lang };
		}
		return { ...p, language: "eng" }; // fallback
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
				eq(entityTranslations.language, lang),
				eq(entityTranslations.source, "urantia.dev"),
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
				aliases: translation.aliases ?? e.aliases,
				description: translation.description ?? e.description,
				language: lang,
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
): Promise<T[]> {
	if (!lang || lang === "eng" || paragraphs.length === 0) {
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
				eq(titleTranslations.language, lang),
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
>(db: any, partRows: T[], lang: string): Promise<T[]> {
	if (!lang || lang === "eng" || partRows.length === 0) {
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
				eq(titleTranslations.language, lang),
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
): Promise<T[]> {
	if (!lang || lang === "eng" || paperRows.length === 0) {
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
	);
	const titles = new Map(translated.map((row) => [row.paperId, row.paperTitle]));
	return paperRows.map((paper) => {
		const title = titles.get(paper.id);
		return title ? { ...paper, title } : paper;
	});
}

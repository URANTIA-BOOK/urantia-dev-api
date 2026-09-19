import { sql } from "drizzle-orm";
import { languages, translationSources } from "../src/db/schema.ts";
import type { TreeMetadata } from "./load-book.ts";
import { basename } from "node:path";

/**
 * Pipeline language_code (ISO 639-2/B in these trees: spa/fre/ger) to the
 * public API ?lang= code. English stays `eng` because that is already the
 * paragraphs.language default and the hub URL when no ?lang= is set.
 */
const PIPELINE_TO_API: Record<string, string> = {
	eng: "eng",
	spa: "es",
	fre: "fr",
	ger: "de",
	nld: "nl",
	por: "pt",
	kor: "ko",
	zho: "zh",
	ara: "ar",
	bul: "bg",
	ces: "cs",
	cze: "cs",
	cz: "cs",
	dan: "da",
};

export function pipelineCodeToApiCode(slug: string): string {
	const key = slug.trim().toLowerCase();
	if (PIPELINE_TO_API[key]) return PIPELINE_TO_API[key];
	if (key === "en") return "eng";
	return key;
}

export function apiCodeToBcp47(code: string, slug: string): string {
	if (code === "eng" || slug === "eng") return "en";
	if (code.length === 2) return code;
	const mapped = pipelineCodeToApiCode(slug);
	return mapped === "eng" ? "en" : mapped;
}

function titleCase(value: string): string {
	if (!value) return value;
	return value.charAt(0).toUpperCase() + value.slice(1);
}

export function languageUiLabels(
	code: string,
	slug: string,
	bcp47: string,
): { uiLabel: string; uiLabelEnglish: string } {
	const native =
		new Intl.DisplayNames([bcp47], { type: "language" }).of(bcp47) ??
		new Intl.DisplayNames([bcp47], { type: "language" }).of(slug) ??
		slug;
	const english =
		new Intl.DisplayNames(["en"], { type: "language" }).of(bcp47) ??
		new Intl.DisplayNames(["en"], { type: "language" }).of(slug) ??
		slug;
	return {
		uiLabel: titleCase(native),
		uiLabelEnglish: titleCase(english),
	};
}

export function languageSortId(code: string): string {
	return code === "eng" ? "0-eng" : `1-${code}`;
}

export function treeSlugFromPath(treePath: string): string {
	const name = basename(treePath.replace(/\/$/, ""));
	return name || "source";
}

export function overlaySourceId(
	languageCode: string,
	sourceTag: string,
	version = 1,
): string {
	if (sourceTag.startsWith("UF-")) return sourceTag;
	return `${languageCode}:${sourceTag}:v${version}`;
}

async function insertLanguage(
	db: any,
	languageCode: string,
	slug: string,
	overwrite: boolean,
): Promise<void> {
	const bcp47 = apiCodeToBcp47(languageCode, slug);
	const labels = languageUiLabels(languageCode, slug, bcp47);
	const values = {
		code: languageCode,
		slug,
		bcp47,
		uiLabel: labels.uiLabel,
		uiLabelEnglish: labels.uiLabelEnglish,
		sortId: languageSortId(languageCode),
	};
	if (overwrite) {
		await db
			.insert(languages)
			.values(values)
			.onConflictDoUpdate({
				target: languages.code,
				set: {
					slug,
					bcp47,
					uiLabel: labels.uiLabel,
					uiLabelEnglish: labels.uiLabelEnglish,
					sortId: languageSortId(languageCode),
				},
			});
		return;
	}
	await db.insert(languages).values(values).onConflictDoNothing();
}

/**
 * Upsert from a language-tree metadata.json. The first edition seeded for a
 * language stays primary (`?lang=`), so a later regional tree (spa_eur) is a
 * selectable source instead of stealing the default.
 */
export async function upsertTranslationSource(
	db: any,
	meta: TreeMetadata,
	treePath: string,
	apiCodeOverride?: string | null,
): Promise<{ languageCode: string; sourceId: string }> {
	const slug = meta.languageCode.toLowerCase();
	const languageCode = (
		apiCodeOverride?.trim() || pipelineCodeToApiCode(slug)
	).toLowerCase();
	const treeSlug = treeSlugFromPath(treePath);
	const sourceId = meta.versionId;

	await insertLanguage(db, languageCode, slug, true);

	const existingPrimary = await db
		.select({ id: translationSources.id })
		.from(translationSources)
		.where(
			sql`${translationSources.languageCode} = ${languageCode} AND ${translationSources.isPrimary} = true`,
		)
		.limit(1);
	const isPrimary =
		existingPrimary.length === 0 || existingPrimary[0].id === sourceId;

	if (isPrimary) {
		await db
			.update(translationSources)
			.set({ isPrimary: false })
			.where(
				sql`${translationSources.languageCode} = ${languageCode} AND ${translationSources.id} <> ${sourceId}`,
			);
	}

	await db
		.insert(translationSources)
		.values({
			id: sourceId,
			languageCode,
			treeSlug,
			versionNumber: meta.versionNumber,
			pipelineVersion: meta.pipelineVersion,
			regionCode: meta.regionCode,
			firstPublished: meta.firstPublished,
			copyrightYear: meta.copyrightYear,
			editionNative: meta.editionNative,
			editionEnglish: meta.editionEnglish,
			bookTitle: meta.bookTitle,
			sourceFile: meta.sourceFile,
			sourceUrl: meta.sourceUrl,
			sourceSha256: meta.sourceSha256,
			sourceLayout: meta.sourceLayout,
			isPrimary,
		})
		.onConflictDoUpdate({
			target: translationSources.id,
			set: {
				languageCode,
				treeSlug,
				versionNumber: meta.versionNumber,
				pipelineVersion: meta.pipelineVersion,
				regionCode: meta.regionCode,
				firstPublished: meta.firstPublished,
				copyrightYear: meta.copyrightYear,
				editionNative: meta.editionNative,
				editionEnglish: meta.editionEnglish,
				bookTitle: meta.bookTitle,
				sourceFile: meta.sourceFile,
				sourceUrl: meta.sourceUrl,
				sourceSha256: meta.sourceSha256,
				sourceLayout: meta.sourceLayout,
				isPrimary,
			},
		});

	return { languageCode, sourceId };
}

/**
 * Ensure a synthetic source for AI / JSON overlay files that have no
 * metadata.json. Does not steal primary from a tree edition.
 */
export async function ensureOverlaySource(
	db: any,
	languageCode: string,
	sourceTag: string,
	version = 1,
): Promise<{ languageCode: string; sourceId: string }> {
	const code = languageCode.toLowerCase();
	const tag = sourceTag.trim() || "overlay";
	await insertLanguage(db, code, code, false);
	const sourceId = overlaySourceId(code, tag, version);
	const existingPrimary = await db
		.select({ id: translationSources.id })
		.from(translationSources)
		.where(
			sql`${translationSources.languageCode} = ${code} AND ${translationSources.isPrimary} = true`,
		)
		.limit(1);
	const isPrimary =
		existingPrimary.length === 0 || existingPrimary[0].id === sourceId;
	await db
		.insert(translationSources)
		.values({
			id: sourceId,
			languageCode: code,
			treeSlug: tag,
			editionEnglish: tag,
			isPrimary,
		})
		.onConflictDoNothing();
	return { languageCode: code, sourceId };
}

/**
 * seed-paragraph-translations.ts — Seed paragraph and title translations into the database
 *
 * Usage:
 *   bun scripts/seed-paragraph-translations.ts
 *   bun scripts/seed-paragraph-translations.ts --lang=es
 *   bun scripts/seed-paragraph-translations.ts --dry-run
 *
 * Reads paragraph and title translation JSON files and upserts into the
 * paragraph_translations and title_translations tables, hanging each row
 * on a translation_sources FK (synthetic when there is no metadata.json).
 * Idempotent via ON CONFLICT DO UPDATE.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { paragraphTranslations, titleTranslations } from "../src/db/schema.ts";
import { sql } from "drizzle-orm";
import {
	ensureOverlaySource,
	overlaySourceId,
} from "./translation-source.ts";

const ROOT = join(import.meta.dir, "..");
const TRANSLATIONS_ROOT = join(ROOT, "data/translations");

const langArg = process.argv.find((a) => a.startsWith("--lang="));
const LANG_FILTER = langArg?.split("=")[1] ?? null;
const DRY_RUN = process.argv.includes("--dry-run");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL && !DRY_RUN) {
	console.error("DATABASE_URL environment variable is required (skip with --dry-run)");
	process.exit(1);
}

type ParagraphTranslation = {
	paragraphId: string;
	globalId: string;
	standardReferenceId: string;
	language: string;
	version: number;
	text: string;
	htmlText: string;
	source: string;
	confidence: string;
};

type TitleTranslation = {
	sourceType: "paper" | "section";
	sourceId: string;
	language: string;
	version: number;
	title: string;
	source: string;
	confidence: string;
};

function discoverLangDirs(): string[] {
	if (LANG_FILTER) return [LANG_FILTER];
	if (!existsSync(TRANSLATIONS_ROOT)) return [];
	return readdirSync(TRANSLATIONS_ROOT, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

const languages = discoverLangDirs();

console.log(`\n=== Seed Paragraph & Title Translations ===\n`);
if (DRY_RUN) console.log("DRY RUN — no database changes\n");

let totalParagraphs = 0;
let totalTitles = 0;

const allParagraphTranslations: ParagraphTranslation[] = [];
const allTitleTranslations: TitleTranslation[] = [];

for (const lang of languages) {
	const paraDir = join(TRANSLATIONS_ROOT, lang, "paragraphs");
	if (existsSync(paraDir)) {
		const files = readdirSync(paraDir).filter((f) => f.endsWith(".json"));
		let langParaCount = 0;
		for (const file of files) {
			const entries: ParagraphTranslation[] = JSON.parse(
				readFileSync(join(paraDir, file), "utf-8"),
			);
			const valid = entries.filter((e) => e.text && e.htmlText);
			allParagraphTranslations.push(...valid);
			langParaCount += valid.length;
		}
		console.log(`  ${lang} paragraphs: ${langParaCount} (from ${files.length} files)`);
		totalParagraphs += langParaCount;
	}

	const titlesPath = join(TRANSLATIONS_ROOT, lang, "titles.json");
	if (existsSync(titlesPath)) {
		const entries: TitleTranslation[] = JSON.parse(readFileSync(titlesPath, "utf-8"));
		allTitleTranslations.push(...entries);
		console.log(`  ${lang} titles: ${entries.length}`);
		totalTitles += entries.length;
	}
}

console.log(`\nTotal: ${totalParagraphs} paragraphs + ${totalTitles} titles`);

if (totalParagraphs === 0 && totalTitles === 0) {
	console.log("\nNo translations to seed.");
	process.exit(0);
}

if (DRY_RUN) {
	console.log("\nDry run complete.");
	process.exit(0);
}

const client = postgres(DATABASE_URL!);
const db = drizzle(client);

const BATCH_SIZE = 100;

function catalogKey(language: string, source: string, version: number): string {
	return overlaySourceId(language, source, version);
}

async function main() {
	const sourceCache = new Map<string, { languageCode: string; sourceId: string }>();
	async function catalogFor(language: string, source: string, version: number) {
		const key = catalogKey(language, source, version);
		const cached = sourceCache.get(key);
		if (cached) return cached;
		const catalog = await ensureOverlaySource(db, language, source, version);
		sourceCache.set(key, catalog);
		return catalog;
	}

	let upsertedParas = 0;
	let upsertedTitles = 0;

	if (allParagraphTranslations.length > 0) {
		console.log(`\nSeeding ${allParagraphTranslations.length} paragraph translations...`);
		for (let i = 0; i < allParagraphTranslations.length; i += BATCH_SIZE) {
			const batch = allParagraphTranslations.slice(i, i + BATCH_SIZE);
			const values = [];
			for (const entry of batch) {
				const catalog = await catalogFor(entry.language, entry.source, entry.version);
				values.push({
					id: `${entry.paragraphId}:${catalog.sourceId}`,
					paragraphId: entry.paragraphId,
					sourceId: catalog.sourceId,
					language: catalog.languageCode,
					version: entry.version,
					text: entry.text,
					htmlText: entry.htmlText,
					source: catalog.sourceId,
					confidence: entry.confidence,
				});
			}

			await db.insert(paragraphTranslations).values(values).onConflictDoUpdate({
				target: paragraphTranslations.id,
				set: {
					sourceId: sql`excluded.source_id`,
					language: sql`excluded.language`,
					text: sql`excluded.text`,
					htmlText: sql`excluded.html_text`,
					source: sql`excluded.source`,
					confidence: sql`excluded.confidence`,
				},
			});

			upsertedParas += batch.length;
			if ((i + BATCH_SIZE) % 1000 === 0 || i + BATCH_SIZE >= allParagraphTranslations.length) {
				console.log(`  ${upsertedParas}/${allParagraphTranslations.length} paragraphs seeded`);
			}
		}
	}

	if (allTitleTranslations.length > 0) {
		console.log(`\nSeeding ${allTitleTranslations.length} title translations...`);
		for (let i = 0; i < allTitleTranslations.length; i += BATCH_SIZE) {
			const batch = allTitleTranslations.slice(i, i + BATCH_SIZE);
			const values = [];
			for (const entry of batch) {
				const catalog = await catalogFor(entry.language, entry.source, entry.version);
				values.push({
					id: `${entry.sourceType}:${entry.sourceId}:${catalog.sourceId}`,
					sourceType: entry.sourceType,
					sourceId: entry.sourceId,
					translationSourceId: catalog.sourceId,
					language: catalog.languageCode,
					version: entry.version,
					title: entry.title,
					source: catalog.sourceId,
					confidence: entry.confidence,
				});
			}

			await db.insert(titleTranslations).values(values).onConflictDoUpdate({
				target: titleTranslations.id,
				set: {
					translationSourceId: sql`excluded.translation_source_id`,
					title: sql`excluded.title`,
					source: sql`excluded.source`,
					confidence: sql`excluded.confidence`,
				},
			});

			upsertedTitles += batch.length;
		}
	}

	console.log(`\nSeeded ${upsertedParas} paragraph translations + ${upsertedTitles} title translations.`);
	await client.end();
}

main().catch(async (err) => {
	console.error("Seeding failed:", err);
	await client.end();
	process.exit(1);
});

/**
 * Seed paragraph_translations and title_translations from a pipeline language tree.
 *
 * Official Foundation companions are the source of truth. This does not write
 * AI overlays. Upserts languages + translation_sources from metadata.json, then
 * hangs each overlay row on that source FK.
 *
 * Usage:
 *   bun scripts/seed-tree-translations.ts --tree=/path/to/langs/spanish
 *   bun scripts/seed-tree-translations.ts --tree=/book/langs/spanish --lang=es
 *   bun scripts/seed-tree-translations.ts --tree=/book/langs/spanish --dry-run
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { paragraphTranslations, titleTranslations } from "../src/db/schema.ts";
import {
	loadBook,
	paragraphBodies,
	partTranslationRows,
	readTreeMetadata,
	resolveBookSource,
	sortedPaperIds,
} from "./load-book.ts";
import {
	pipelineCodeToApiCode,
	upsertTranslationSource,
} from "./translation-source.ts";

const DRY_RUN = process.argv.includes("--dry-run");
const treeArg = process.argv.find((a) => a.startsWith("--tree="))?.slice("--tree=".length);
const langArg = process.argv.find((a) => a.startsWith("--lang="))?.slice("--lang=".length);

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL && !DRY_RUN) {
	console.error("DATABASE_URL is required (skip with --dry-run)");
	process.exit(1);
}

const treePath = resolveBookSource(treeArg);
const book = loadBook(treePath);
const meta = readTreeMetadata(book.source);
if (!meta) {
	console.error(`No metadata.json at ${book.source}`);
	process.exit(2);
	throw new Error(`No metadata.json at ${book.source}`);
}

const version = 1;

type ParaRow = {
	id: string;
	paragraphId: string;
	sourceId: string;
	language: string;
	version: number;
	text: string;
	htmlText: string;
	source: string;
	confidence: string;
};

type TitleRow = {
	id: string;
	sourceType: string;
	sourceId: string;
	translationSourceId: string;
	language: string;
	version: number;
	title: string;
	source: string;
	confidence: string;
};

function collectRows(languageCode: string, translationSourceId: string) {
	const paraValues: ParaRow[] = [];
	const titleValues: TitleRow[] = [];
	const seenTitle = new Set<string>();

	function addTitle(sourceType: string, sourceId: string, title: string | null | undefined) {
		if (!title || !sourceId) return;
		const id = `${sourceType}:${sourceId}:${translationSourceId}`;
		if (seenTitle.has(id)) return;
		seenTitle.add(id);
		titleValues.push({
			id,
			sourceType,
			sourceId,
			translationSourceId,
			language: languageCode,
			version,
			title,
			source: translationSourceId,
			confidence: "high",
		});
	}

	for (const paperId of sortedPaperIds(book)) {
		const rows = book.papers.get(paperId);
		if (!rows) continue;
		for (const row of rows) {
			if (row.type === "paper" && row.paperId && row.paperTitle) {
				addTitle("paper", String(row.paperId), row.paperTitle);
			}
			if (row.type === "section" && row.paperSectionId && row.sectionTitle) {
				addTitle("section", row.paperSectionId, row.sectionTitle);
			}
			if (row.type !== "paragraph") continue;
			const bodies = paragraphBodies(row);
			if (!bodies) continue;
			paraValues.push({
				id: `${row.globalId}:${translationSourceId}`,
				paragraphId: row.globalId,
				sourceId: translationSourceId,
				language: languageCode,
				version,
				text: bodies.text,
				htmlText: bodies.htmlText,
				source: translationSourceId,
				confidence: "high",
			});
		}
	}

	for (const part of partTranslationRows(book)) {
		addTitle(part.sourceType, part.sourceId, part.title);
	}

	return { paraValues, titleValues };
}

const inferredLang = langArg || undefined;
console.log(`tree: ${book.source}`);
console.log(`metadata: ${meta.versionId} slug=${meta.languageCode}`);

if (DRY_RUN) {
	const languageCode = pipelineCodeToApiCode(
		inferredLang || meta.languageCode,
	).toLowerCase();
	const { paraValues, titleValues } = collectRows(languageCode, meta.versionId);
	console.log(`api lang (dry): ${languageCode}`);
	console.log(`paragraphs: ${paraValues.length}  titles: ${titleValues.length}`);
	console.log("DRY RUN — no database changes");
	process.exit(0);
}

const client = postgres(DATABASE_URL!);
const db = drizzle(client);
const BATCH = 200;

async function main() {
	const catalog = await upsertTranslationSource(db, meta, book.source, inferredLang);
	const { paraValues, titleValues } = collectRows(catalog.languageCode, catalog.sourceId);
	console.log(`api lang: ${catalog.languageCode}  source: ${catalog.sourceId}`);
	console.log(`paragraphs: ${paraValues.length}  titles: ${titleValues.length}`);

	for (let i = 0; i < paraValues.length; i += BATCH) {
		const batch = paraValues.slice(i, i + BATCH);
		await db.insert(paragraphTranslations).values(batch).onConflictDoUpdate({
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
		if ((i + BATCH) % 1000 === 0 || i + BATCH >= paraValues.length) {
			console.log(`  paragraphs ${Math.min(i + BATCH, paraValues.length)}/${paraValues.length}`);
		}
	}
	for (let i = 0; i < titleValues.length; i += BATCH) {
		const batch = titleValues.slice(i, i + BATCH);
		await db.insert(titleTranslations).values(batch).onConflictDoUpdate({
			target: titleTranslations.id,
			set: {
				translationSourceId: sql`excluded.translation_source_id`,
				title: sql`excluded.title`,
				source: sql`excluded.source`,
				confidence: sql`excluded.confidence`,
			},
		});
	}
	console.log("tree translations seeded");
	await client.end();
}

main().catch(async (err) => {
	console.error(err);
	await client.end();
	process.exit(1);
});

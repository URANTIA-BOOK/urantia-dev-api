/**
 * Seed paragraph_translations and title_translations from a pipeline language tree.
 *
 * Official Foundation companions are the source of truth. This does not write
 * AI overlays. API language codes (es, fr, de) are a later-stage alias of the
 * pipeline language_code (spa, fre, ger).
 *
 * Usage:
 *   bun scripts/seed-tree-translations.ts --tree=/path/to/langs/spanish --lang=es
 *   bun scripts/seed-tree-translations.ts --tree=/book/langs/spanish --lang=es --dry-run
 */

import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { paragraphTranslations, titleTranslations } from "../src/db/schema.ts";
import {
	loadBook,
	paragraphBodies,
	resolveBookSource,
	sortedPaperIds,
} from "./load-book.ts";

const DRY_RUN = process.argv.includes("--dry-run");
const treeArg = process.argv.find((a) => a.startsWith("--tree="))?.slice("--tree=".length);
const langArg = process.argv.find((a) => a.startsWith("--lang="))?.slice("--lang=".length);

if (!langArg) {
	console.error("Pass --lang=es (API language code)");
	process.exit(2);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL && !DRY_RUN) {
	console.error("DATABASE_URL is required (skip with --dry-run)");
	process.exit(1);
}

const book = loadBook(resolveBookSource(treeArg));
const source = book.envelope?.version_id ?? book.source;
const version = 1;

type ParaRow = {
	id: string;
	paragraphId: string;
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
	language: string;
	version: number;
	title: string;
	source: string;
	confidence: string;
};

const paraValues: ParaRow[] = [];
const titleValues: TitleRow[] = [];
const seenTitle = new Set<string>();

function addTitle(sourceType: string, sourceId: string, title: string | null | undefined) {
	if (!title || !sourceId) return;
	const id = `${sourceType}:${sourceId}:${langArg}:v${version}`;
	if (seenTitle.has(id)) return;
	seenTitle.add(id);
	titleValues.push({
		id,
		sourceType,
		sourceId,
		language: langArg,
		version,
		title,
		source,
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
			id: `${row.globalId}:${langArg}:v${version}`,
			paragraphId: row.globalId,
			language: langArg,
			version,
			text: bodies.text,
			htmlText: bodies.htmlText,
			source,
			confidence: "high",
		});
	}
}

console.log(`tree: ${book.source}`);
console.log(`api lang: ${langArg}  source: ${source}`);
console.log(`paragraphs: ${paraValues.length}  titles: ${titleValues.length}`);

if (DRY_RUN) {
	console.log("DRY RUN — no database changes");
	process.exit(0);
}

const client = postgres(DATABASE_URL!);
const db = drizzle(client);
const BATCH = 200;

async function main() {
	for (let i = 0; i < paraValues.length; i += BATCH) {
		const batch = paraValues.slice(i, i + BATCH);
		await db.insert(paragraphTranslations).values(batch).onConflictDoUpdate({
			target: paragraphTranslations.id,
			set: {
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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { paragraphs, papers, parts, sections } from "../src/db/schema.ts";
import {
	loadBook,
	paragraphBodies,
	resolveBookSource,
	sortedPaperIds,
	summarizeBook,
} from "./load-book.ts";

const DRY_RUN = process.argv.includes("--dry-run");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL && !DRY_RUN) {
	console.error("DATABASE_URL environment variable is required (skip with --dry-run)");
	process.exit(1);
}

const BOOK_SOURCE = resolveBookSource();

const MANIFEST_PATH =
	process.env.AUDIO_MANIFEST ??
	join(import.meta.dir, "../data/audio-manifest.json");

const VIDEO_MANIFEST_PATH =
	process.env.VIDEO_MANIFEST ??
	join(import.meta.dir, "../data/video-manifest.json");

let audioManifest: Record<
	string,
	Record<string, Record<string, { format: string; url: string }>>
> = {};
if (existsSync(MANIFEST_PATH)) {
	audioManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
	console.log(`Audio manifest loaded: ${Object.keys(audioManifest).length} paragraphs`);
} else {
	console.warn(`Audio manifest not found at ${MANIFEST_PATH} — audio will be null`);
}

let videoManifest: Record<
	string,
	Record<string, { mp4: string; thumbnail: string; duration: number }>
> = {};
if (existsSync(VIDEO_MANIFEST_PATH)) {
	videoManifest = JSON.parse(readFileSync(VIDEO_MANIFEST_PATH, "utf-8"));
	console.log(`Video manifest loaded: ${Object.keys(videoManifest).length} papers`);
} else {
	console.warn(`Video manifest not found at ${VIDEO_MANIFEST_PATH} — video will be null`);
}

async function seed() {
	const book = loadBook(BOOK_SOURCE);
	const summary = summarizeBook(book);

	console.log(`Seeding from ${book.kind}: ${book.source}`);
	if (book.envelope) {
		console.log(
			`  ${book.envelope.language ?? "?"} ${book.envelope.version_id ?? ""} pipeline_version=${book.envelope.pipeline_version ?? "?"}`,
		);
	}
	console.log(
		`  indexed ${summary.parts} parts, ${summary.papers} papers, ${summary.sections} sections, ${summary.paragraphs} paragraphs, ${summary.dividers} dividers`,
	);

	if (DRY_RUN) {
		console.log("\nDRY RUN — no database changes");
		return;
	}

	const client = postgres(DATABASE_URL!);
	const db = drizzle(client);

	console.log("\n--- Seeding parts ---");
	for (const partNode of book.parts) {
		await db
			.insert(parts)
			.values({
				id: partNode.partId,
				title: partNode.partTitle ?? `Part ${partNode.partId}`,
				sponsorship: partNode.partSponsorship ?? null,
				sortId: partNode.sortId,
			})
			.onConflictDoNothing();
		console.log(`  Inserted part ${partNode.partId}: ${partNode.partTitle}`);
	}

	console.log("\n--- Seeding papers, sections, and paragraphs ---");

	let totalPapers = 0;
	let totalSections = 0;
	let totalParagraphs = 0;

	for (const paperId of sortedPaperIds(book)) {
		const nodes = book.papers.get(paperId);
		if (!nodes) continue;

		const paperNode = nodes.find((n) => n.type === "paper");
		if (paperNode && paperNode.paperId) {
			await db
				.insert(papers)
				.values({
					id: paperNode.paperId,
					partId: paperNode.partId,
					title: paperNode.paperTitle ?? `Paper ${paperNode.paperId}`,
					globalId: paperNode.globalId,
					sortId: paperNode.sortId,
					labels: paperNode.labels ?? [],
					video: videoManifest[paperNode.paperId] ?? null,
				})
				.onConflictDoNothing();
			totalPapers++;
		}

		const sectionNodes = nodes.filter((n) => n.type === "section");
		for (const sn of sectionNodes) {
			if (sn.paperSectionId) {
				await db
					.insert(sections)
					.values({
						id: sn.paperSectionId,
						paperId: sn.paperId!,
						sectionId: sn.sectionId!,
						title: sn.sectionTitle ?? null,
						globalId: sn.globalId,
						sortId: sn.sortId,
					})
					.onConflictDoNothing();
				totalSections++;
			}
		}

		const paraValues = [];
		for (const p of nodes) {
			if (p.type !== "paragraph") continue;
			const bodies = paragraphBodies(p);
			if (!bodies) continue;
			if (!p.standardReferenceId || !p.paperSectionParagraphId || !p.paragraphId) {
				continue;
			}
			paraValues.push({
				id: p.globalId,
				globalId: p.globalId,
				standardReferenceId: p.standardReferenceId,
				paperSectionParagraphId: p.paperSectionParagraphId,
				sortId: p.sortId,
				paperId: p.paperId!,
				sectionId: p.paperSectionId ?? null,
				partId: p.partId,
				paperTitle: p.paperTitle ?? "",
				sectionTitle: p.sectionTitle ?? null,
				paragraphId: p.paragraphId,
				language: p.language ?? "eng",
				text: bodies.text,
				htmlText: bodies.htmlText,
				labels: p.labels ?? [],
				audio: audioManifest[p.globalId] ?? null,
			});
		}

		for (let i = 0; i < paraValues.length; i += 500) {
			const batch = paraValues.slice(i, i + 500);
			await db.insert(paragraphs).values(batch).onConflictDoNothing();
		}

		totalParagraphs += paraValues.length;
		console.log(
			`  paper ${paperId}: ${paraValues.length} paragraphs, ${sectionNodes.length} sections`,
		);
	}

	console.log("\n--- Seed complete ---");
	console.log(`  Parts: ${book.parts.length}`);
	console.log(`  Papers: ${totalPapers}`);
	console.log(`  Sections: ${totalSections}`);
	console.log(`  Paragraphs: ${totalParagraphs}`);

	await client.end();
}

seed().catch((err) => {
	console.error("Seed failed:", err);
	process.exit(1);
});

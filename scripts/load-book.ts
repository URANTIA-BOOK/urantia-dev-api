/**
 * Load spoken rows from a pipeline language tree (or a retired flat json/eng).
 *
 * Language trees are the source of truth: each document's companion is an
 * envelope with `rows`. This module unwraps that envelope (or a retired bare
 * array) and prefers `markdown` over `text`.
 *
 * `labels`, `objectID`, `htmlText`, and flattened `text` are not stored on
 * the tree. Seed derives `text` / `htmlText` here so the API contract stays
 * stable. Dividers are skipped by callers that filter on `type === "paragraph"`.
 *
 * Usage:
 *   bun scripts/load-book.ts
 *   BOOK_TREE=../../URANTIA/source bun scripts/load-book.ts
 *   bun scripts/load-book.ts --tree /path/to/langs/spanish
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type BookRow = {
	type: string;
	typeRank?: number;
	language?: string;
	partId: string;
	paperId?: string | null;
	sectionId?: string | null;
	paragraphId?: string | null;
	paperSectionId?: string | null;
	paperSectionParagraphId?: string | null;
	globalId: string;
	standardReferenceId?: string | null;
	sortId: string;
	paperTitle?: string | null;
	sectionTitle?: string | null;
	markdown?: string | null;
	text?: string | null;
	htmlText?: string | null;
	labels?: string[];
	partTitle?: string | null;
	partSponsorship?: string | null;
};

export type CompanionEnvelope = {
	language?: string;
	version_id?: string;
	pipeline_version?: number;
	source_file?: string;
};

export type IndexedBook = {
	source: string;
	kind: "tree" | "flat";
	envelope: CompanionEnvelope | null;
	parts: BookRow[];
	papers: Map<string, BookRow[]>;
};

export type BookSummary = {
	parts: number;
	papers: number;
	sections: number;
	paragraphs: number;
	dividers: number;
};

const FOREWORD_PART: BookRow = {
	type: "part",
	typeRank: 0,
	language: "eng",
	partId: "0",
	paperId: null,
	sectionId: null,
	paragraphId: null,
	paperSectionId: null,
	paperSectionParagraphId: null,
	globalId: "0:-.-.-",
	standardReferenceId: null,
	sortId: "0.000.000.000",
	paperTitle: null,
	sectionTitle: null,
	partTitle: "Foreword",
	partSponsorship: null,
};

function here(): string {
	if ("dir" in import.meta && typeof import.meta.dir === "string") {
		return import.meta.dir;
	}
	return import.meta.dirname;
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Unwrap a companion envelope or a retired bare array. */
export function rowsOf(payload: unknown): BookRow[] {
	if (payload && typeof payload === "object" && !Array.isArray(payload)) {
		const rows = (payload as { rows?: unknown }).rows;
		if (Array.isArray(rows)) return rows as BookRow[];
	}
	if (Array.isArray(payload)) return payload as BookRow[];
	throw new Error("JSON is neither a companion envelope nor a row array");
}

export function envelopeOf(payload: unknown): CompanionEnvelope | null {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return null;
	}
	const obj = payload as CompanionEnvelope;
	if (obj.version_id || obj.pipeline_version || obj.source_file) {
		return {
			language: obj.language,
			version_id: obj.version_id,
			pipeline_version: obj.pipeline_version,
			source_file: obj.source_file,
		};
	}
	return null;
}

export function flattenMarkdown(markdown: string): string {
	return markdown.replace(/\*([^*]+)\*/g, "$1");
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Presentation HTML for the API / hub. Derived at seed time — not stored on
 * the language tree. The `urantia-dev-pb-0` class is hub stylesheet, applied
 * here as a later stage rather than baked into companions.
 */
export function markdownToHtml(markdown: string): string {
	const withEm = escapeHtml(markdown).replace(
		/\*([^*]+)\*/g,
		"<em>$1</em>",
	);
	return `<span class="urantia-dev-pb-0">${withEm}</span>`;
}

/** Spoken / stored body: markdown as written, else retired text. */
export function rowBody(row: BookRow): string | null {
	if (nonempty(row.markdown)) return row.markdown;
	if (nonempty(row.text)) return row.text;
	return null;
}

export function paragraphBodies(
	row: BookRow,
): { text: string; htmlText: string } | null {
	const markdown = rowBody(row);
	if (!markdown) return null;
	const text = nonempty(row.markdown)
		? flattenMarkdown(row.markdown)
		: nonempty(row.text)
			? row.text
			: flattenMarkdown(markdown);
	const htmlText = nonempty(row.htmlText)
		? row.htmlText
		: markdownToHtml(markdown);
	return { text, htmlText };
}

export function resolveBookSource(explicit?: string | null): string {
	if (explicit) return explicit;
	if (process.env.BOOK_TREE) return process.env.BOOK_TREE;
	if (process.env.DATA_DIR) return process.env.DATA_DIR;

	const pipeline = join(here(), "../../URANTIA/source");
	if (existsSync(join(pipeline, "metadata.json"))) return pipeline;

	return join(here(), "../../urantia-data-sources/data/json/eng");
}

function* walkJson(dir: string): Generator<string> {
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			yield* walkJson(full);
			continue;
		}
		if (name.endsWith(".json") && name !== "metadata.json") {
			yield full;
		}
	}
}

export function loadBook(source = resolveBookSource()): IndexedBook {
	if (!existsSync(source)) {
		throw new Error(`book source not found: ${source}`);
	}

	const kind: "tree" | "flat" = existsSync(join(source, "metadata.json"))
		? "tree"
		: "flat";
	const papers = new Map<string, BookRow[]>();
	const parts: BookRow[] = [];
	let envelope: CompanionEnvelope | null = null;

	for (const file of walkJson(source)) {
		let payload: unknown;
		try {
			payload = JSON.parse(readFileSync(file, "utf-8"));
		} catch {
			continue;
		}
		let rows: BookRow[];
		try {
			rows = rowsOf(payload);
		} catch {
			continue;
		}
		if (!envelope) {
			envelope = envelopeOf(payload);
		}

		let paperId: string | undefined;
		for (const row of rows) {
			if (row.type === "part") parts.push(row);
			if (row.type === "paper" && row.paperId != null && row.paperId !== "") {
				paperId = String(row.paperId);
			}
		}
		if (paperId !== undefined) {
			papers.set(paperId, rows);
		}
	}

	if (!parts.some((p) => String(p.partId) === "0")) {
		parts.unshift(FOREWORD_PART);
	}

	parts.sort((a, b) => a.sortId.localeCompare(b.sortId));

	return { source, kind, envelope, parts, papers };
}

export function summarizeBook(book: IndexedBook): BookSummary {
	let sections = 0;
	let paragraphs = 0;
	let dividers = 0;
	for (const rows of book.papers.values()) {
		for (const row of rows) {
			if (row.type === "section") sections += 1;
			else if (row.type === "paragraph" && rowBody(row)) paragraphs += 1;
			else if (row.type === "divider") dividers += 1;
		}
	}
	return {
		parts: book.parts.length,
		papers: book.papers.size,
		sections,
		paragraphs,
		dividers,
	};
}

export function sortedPaperIds(book: IndexedBook): string[] {
	return [...book.papers.keys()].sort(
		(a, b) => Number(a) - Number(b) || a.localeCompare(b),
	);
}

function printSummary(book: IndexedBook): void {
	const summary = summarizeBook(book);
	console.log(`source: ${book.source}`);
	console.log(`kind: ${book.kind}`);
	if (book.envelope) {
		console.log(
			`envelope: language=${book.envelope.language ?? "?"} version_id=${book.envelope.version_id ?? "?"} pipeline_version=${book.envelope.pipeline_version ?? "?"}`,
		);
	}
	console.log(`parts: ${summary.parts}`);
	console.log(`papers: ${summary.papers}`);
	console.log(`sections: ${summary.sections}`);
	console.log(`paragraphs with body: ${summary.paragraphs}`);
	console.log(`dividers: ${summary.dividers}`);
}

const invoked =
	typeof import.meta.main === "boolean"
		? import.meta.main
		: (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/load-book.ts") ??
			false);

if (invoked) {
	const treeArg = process.argv.find((a) => a.startsWith("--tree="))?.slice("--tree=".length);
	const book = loadBook(resolveBookSource(treeArg));
	printSummary(book);
	const expectedPapers = 197;
	if (book.papers.size !== expectedPapers) {
		console.error(`expected ${expectedPapers} papers, indexed ${book.papers.size}`);
		process.exit(1);
	}
}

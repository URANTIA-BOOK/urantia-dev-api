import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
	envelopeOf,
	flattenMarkdown,
	loadBook,
	markdownToHtml,
	paragraphBodies,
	partTranslationRows,
	readMetadataParts,
	rowsOf,
	summarizeBook,
} from "../../scripts/load-book.ts";

describe("rowsOf", () => {
	it("unwraps a companion envelope", () => {
		const rows = rowsOf({
			language: "eng",
			version_id: "UF-ENG-001-1955-1.22",
			pipeline_version: 3,
			rows: [{ type: "paper", partId: "1", paperId: "1", globalId: "1:1.-.-", sortId: "1.001.000.000" }],
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.type).toBe("paper");
	});

	it("accepts a retired bare array", () => {
		const rows = rowsOf([
			{ type: "paragraph", partId: "1", globalId: "1:1.0.1", sortId: "1.001.000.001", text: "Hello" },
		]);
		expect(rows[0]?.text).toBe("Hello");
	});

	it("rejects an object without rows", () => {
		expect(() => rowsOf({ language: "eng" })).toThrow(/neither/);
	});
});

describe("envelopeOf", () => {
	it("reads companion metadata", () => {
		const env = envelopeOf({
			language: "spa",
			version_id: "UF-SPA-419-1993-1.9",
			pipeline_version: 3,
			source_file: "part-1/001.md",
			rows: [],
		});
		expect(env?.language).toBe("spa");
		expect(env?.version_id).toBe("UF-SPA-419-1993-1.9");
		expect(env?.pipeline_version).toBe(3);
	});

	it("returns null for a retired array", () => {
		expect(envelopeOf([])).toBeNull();
	});
});

describe("paragraphBodies", () => {
	it("prefers markdown and derives text plus htmlText", () => {
		const bodies = paragraphBodies({
			type: "paragraph",
			partId: "1",
			globalId: "1:1.0.1",
			sortId: "1.001.000.001",
			markdown: "The name *God.*",
		});
		expect(bodies?.text).toBe("The name God.");
		expect(bodies?.htmlText).toBe(
			'<span class="urantia-dev-pb-0">The name <em>God.</em></span>',
		);
	});

	it("keeps retired htmlText when markdown is absent", () => {
		const bodies = paragraphBodies({
			type: "paragraph",
			partId: "1",
			globalId: "1:1.0.1",
			sortId: "1.001.000.001",
			text: "Hello",
			htmlText: '<span class="urantia-dev-pb-0">Hello</span>',
		});
		expect(bodies?.text).toBe("Hello");
		expect(bodies?.htmlText).toBe('<span class="urantia-dev-pb-0">Hello</span>');
	});

	it("skips empty bodies", () => {
		expect(
			paragraphBodies({
				type: "paragraph",
				partId: "1",
				globalId: "1:1.0.1",
				sortId: "1.001.000.001",
				markdown: null,
			}),
		).toBeNull();
	});
});

describe("flattenMarkdown / markdownToHtml", () => {
	it("strips emphasis markers", () => {
		expect(flattenMarkdown("only a *person* can love")).toBe("only a person can love");
	});

	it("escapes HTML then wraps emphasis", () => {
		expect(markdownToHtml("a <b> and *c*")).toBe(
			'<span class="urantia-dev-pb-0">a &lt;b&gt; and <em>c</em></span>',
		);
	});
});

function firstExisting(...candidates: string[]): string | null {
	return candidates.find((path) => existsSync(join(path, "metadata.json"))) ?? null;
}

const englishTree = firstExisting(
	join(import.meta.dir, "../../../URANTIA/source"),
	"/book/eng",
);
const spanishTree = firstExisting(
	join(import.meta.dir, "../../../URANTIA/langs/spanish"),
	"/book/langs/spanish",
);

if (englishTree) {
	describe("English pipeline tree on disk", () => {
		it("indexes the measured companion counts", () => {
			const summary = summarizeBook(loadBook(englishTree));
			expect(summary.papers).toBe(197);
			expect(summary.parts).toBe(5);
			expect(summary.sections).toBe(1626);
			expect(summary.paragraphs).toBe(14586);
			expect(summary.dividers).toBe(10);
		});
	});
}

if (spanishTree) {
	describe("Spanish metadata.json part titles", () => {
		it("reads the five edition part titles", () => {
			const parts = readMetadataParts(spanishTree);
			expect(parts.map((part) => [String(part.id), part.title])).toEqual([
				["0", "Prólogo"],
				["1", "El Universo Central y los Superuniversos"],
				["2", "El Universo Local"],
				["3", "La Historia de Urantia"],
				["4", "La Vida y las Enseñanzas de Jesus"],
			]);
		});

		it("overlays those titles onto the loaded tree, including part 0", () => {
			const book = loadBook(spanishTree);
			expect(
				book.parts.map((part) => [String(part.partId), part.partTitle]),
			).toEqual([
				["0", "Prólogo"],
				["1", "El Universo Central y los Superuniversos"],
				["2", "El Universo Local"],
				["3", "La Historia de Urantia"],
				["4", "La Vida y las Enseñanzas de Jesus"],
			]);
			const rows = partTranslationRows(book);
			expect(rows.filter((row) => row.sourceType === "part")).toHaveLength(5);
			expect(
				rows.find((row) => row.sourceType === "partSponsorship" && row.sourceId === "1")
					?.title,
			).toMatch(/Uversa/);
		});
	});
}

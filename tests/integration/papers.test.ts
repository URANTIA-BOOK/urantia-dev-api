import { describe, expect, it } from "bun:test";
import { get } from "../helpers/app.ts";
import {
	assertPaperShape,
	assertPaperWithEntitiesShape,
	assertParagraphShape,
	assertSectionShape,
	assertTopEntityShape,
} from "../helpers/shapes.ts";

describe("GET /papers", () => {
	it("returns 200", async () => {
		const res = await get("/papers");
		expect(res.status).toBe(200);
	});

	it("returns a non-empty array", async () => {
		const res = await get("/papers");
		const { data } = await res.json();
		expect(data).toBeArray();
		expect(data.length).toBeGreaterThan(0);
	});

	it("each paper has exact 6-key shape", async () => {
		const res = await get("/papers");
		const { data } = await res.json();
		for (const paper of data) {
			assertPaperShape(paper);
		}
	});

	it("papers are ordered by sortId ascending", async () => {
		const res = await get("/papers");
		const { data } = await res.json();
		for (let i = 1; i < data.length; i++) {
			expect(data[i].sortId >= data[i - 1].sortId).toBe(true);
		}
	});

	it("papers include video field with nova voice", async () => {
		const res = await get("/papers");
		const { data } = await res.json();
		const paper = data.find((p: any) => p.id === "1");
		expect(paper.video).toBeDefined();
		expect(paper.video.nova).toBeDefined();
		expect(paper.video.nova.mp4).toContain("video.urantiahub.com");
		expect(paper.video.nova.thumbnail).toContain("thumbnail-1.png");
		expect(paper.video.nova.duration).toBeGreaterThan(0);
	});
});

describe("GET /papers/:id (valid)", () => {
	it("returns 200 for paper 2", async () => {
		const res = await get("/papers/2");
		expect(res.status).toBe(200);
	});

	it("response has { paper, paragraphs }", async () => {
		const res = await get("/papers/2");
		const { data } = await res.json();
		expect(data.paper).toBeDefined();
		expect(data.paragraphs).toBeArray();
		expect(data.paragraphs.length).toBeGreaterThan(0);
	});

	it("paper has exact 6-key shape", async () => {
		const res = await get("/papers/2");
		const { data } = await res.json();
		assertPaperShape(data.paper);
	});

	it("each paragraph has exact 13-key shape", async () => {
		const res = await get("/papers/2");
		const { data } = await res.json();
		for (const p of data.paragraphs) {
			assertParagraphShape(p);
		}
	});

	it("sectionId is just the section number, not composite", async () => {
		const res = await get("/papers/2");
		const { data } = await res.json();
		for (const p of data.paragraphs) {
			if (p.sectionId !== null) {
				expect(p.sectionId).not.toContain(".");
			}
		}
	});

	it("paragraphs are ordered by sortId ascending", async () => {
		const res = await get("/papers/2");
		const { data } = await res.json();
		for (let i = 1; i < data.paragraphs.length; i++) {
			expect(
				data.paragraphs[i].sortId >= data.paragraphs[i - 1].sortId,
			).toBe(true);
		}
	});
});

describe("GET /papers/:id?include=entities", () => {
	it("attaches topEntities to the paper object", async () => {
		const res = await get("/papers/1?include=entities");
		expect(res.status).toBe(200);
		const { data } = await res.json();
		assertPaperWithEntitiesShape(data.paper);
		expect(data.paper.topEntities).toBeArray();
		expect(data.paper.topEntities.length).toBeGreaterThan(0);
		expect(data.paper.topEntities.length).toBeLessThanOrEqual(12);
	});

	it("each top entity has the expected 4-key shape", async () => {
		const res = await get("/papers/1?include=entities");
		const { data } = await res.json();
		for (const e of data.paper.topEntities) {
			assertTopEntityShape(e);
			expect(typeof e.count).toBe("number");
			expect(e.count).toBeGreaterThan(0);
		}
	});

	it("top entities are sorted by count descending", async () => {
		const res = await get("/papers/1?include=entities");
		const { data } = await res.json();
		for (let i = 1; i < data.paper.topEntities.length; i++) {
			expect(data.paper.topEntities[i - 1].count).toBeGreaterThanOrEqual(
				data.paper.topEntities[i].count,
			);
		}
	});

	it("does not attach topEntities when include=entities is absent", async () => {
		const res = await get("/papers/1");
		const { data } = await res.json();
		assertPaperShape(data.paper);
		expect(data.paper.topEntities).toBeUndefined();
	});
});

describe("GET /papers/:id?include=topEntities (alone)", () => {
	it("returns topEntities on paper without entities on paragraphs", async () => {
		const res = await get("/papers/1?include=topEntities");
		expect(res.status).toBe(200);
		const { data } = await res.json();
		assertPaperWithEntitiesShape(data.paper);
		expect(data.paper.topEntities).toBeArray();
		expect(data.paper.topEntities.length).toBeGreaterThan(0);
		// paragraphs should have the base shape (no `entities` key)
		for (const p of data.paragraphs) {
			expect(p.entities).toBeUndefined();
		}
	});
});

describe("GET /papers/:id?include=entities,topEntities", () => {
	it("returns both per-paragraph entities and paper-level topEntities", async () => {
		const res = await get("/papers/1?include=entities,topEntities");
		expect(res.status).toBe(200);
		const { data } = await res.json();
		assertPaperWithEntitiesShape(data.paper);
		expect(data.paper.topEntities).toBeArray();
		// at least one paragraph should have the entities array attached
		const someHaveEntities = data.paragraphs.some(
			(p: { entities?: unknown[] }) => Array.isArray(p.entities),
		);
		expect(someHaveEntities).toBe(true);
	});
});

describe("GET /papers?include=topEntities (list endpoint)", () => {
	it("attaches topEntities to every paper in the list", async () => {
		const res = await get("/papers?include=topEntities");
		expect(res.status).toBe(200);
		const { data } = await res.json();
		expect(data).toBeArray();
		expect(data.length).toBeGreaterThan(0);
		for (const paper of data) {
			assertPaperWithEntitiesShape(paper);
			expect(paper.topEntities).toBeArray();
			expect(paper.topEntities.length).toBeLessThanOrEqual(12);
		}
	});

	it("paper 1 tops start with the Universal Father", async () => {
		const res = await get("/papers?include=topEntities");
		const { data } = await res.json();
		const paper1 = data.find((p: { id: string }) => p.id === "1");
		expect(paper1).toBeDefined();
		expect(paper1.topEntities[0].name).toBe("Universal Father");
	});

	it("every top entity has the 4-key shape", async () => {
		const res = await get("/papers?include=topEntities");
		const { data } = await res.json();
		const paper1 = data.find((p: { id: string }) => p.id === "1");
		for (const e of paper1.topEntities) {
			assertTopEntityShape(e);
		}
	});

	it("without the flag, topEntities is absent on every paper", async () => {
		const res = await get("/papers");
		const { data } = await res.json();
		for (const paper of data) {
			assertPaperShape(paper);
			expect(paper.topEntities).toBeUndefined();
		}
	});

	it("completes in under 5 seconds (latency sanity check)", async () => {
		const start = Date.now();
		const res = await get("/papers?include=topEntities");
		const elapsed = Date.now() - start;
		expect(res.status).toBe(200);
		expect(elapsed).toBeLessThan(5000);
	});

	it("ignores lowercase 'topentities' (case-sensitive token match)", async () => {
		const res = await get("/papers?include=topentities");
		const { data } = await res.json();
		for (const paper of data) {
			assertPaperShape(paper);
			expect(paper.topEntities).toBeUndefined();
		}
	});
});

describe("GET /papers/:id (invalid)", () => {
	it("returns 404 for paper 999", async () => {
		const res = await get("/papers/999");
		expect(res.status).toBe(404);
		const json = await res.json();
		expect(json.detail).toBeString();
		expect(json.status).toBe(404);
	});
});

describe("GET /papers/:id/sections", () => {
	it("returns 200 for paper 1", async () => {
		const res = await get("/papers/1/sections");
		expect(res.status).toBe(200);
	});

	it("each section has exact 6-key shape", async () => {
		const res = await get("/papers/1/sections");
		const { data } = await res.json();
		expect(data).toBeArray();
		for (const s of data) {
			assertSectionShape(s);
		}
	});

	it("sections are ordered by sortId ascending", async () => {
		const res = await get("/papers/1/sections");
		const { data } = await res.json();
		for (let i = 1; i < data.length; i++) {
			expect(data[i].sortId >= data[i - 1].sortId).toBe(true);
		}
	});

	it("returns 404 for paper 999", async () => {
		const res = await get("/papers/999/sections");
		expect(res.status).toBe(404);
	});
});

describe("GET /papers/:id?lang=", () => {
	it("accepts lang=es without failing", async () => {
		const res = await get("/papers/1?lang=es");
		expect(res.status).toBe(200);
		const { data } = await res.json();
		expect(data.paper).toBeDefined();
		expect(data.paragraphs).toBeArray();
		expect(data.paragraphs.length).toBeGreaterThan(0);
	});
});

import { describe, expect, it } from "bun:test";
import { get } from "../helpers/app.ts";

describe("GET /toc", () => {
	it("returns 200", async () => {
		const res = await get("/toc");
		expect(res.status).toBe(200);
	});

	it("returns { data: { parts: [...] } }", async () => {
		const res = await get("/toc");
		const json = await res.json();
		expect(json.data).toBeDefined();
		expect(json.data.parts).toBeArray();
		expect(json.data.parts.length).toBeGreaterThan(0);
	});

	it("each part has { id, title, sponsorship, papers }", async () => {
		const res = await get("/toc");
		const { parts } = (await res.json()).data;
		for (const part of parts) {
			expect(Object.keys(part).sort()).toEqual(
				["id", "papers", "sponsorship", "title"].sort(),
			);
		}
	});

	it("each paper within a part has exactly { id, title, labels }", async () => {
		const res = await get("/toc");
		const { parts } = (await res.json()).data;
		for (const part of parts) {
			for (const paper of part.papers) {
				expect(Object.keys(paper).sort()).toEqual(
					["id", "labels", "title"].sort(),
				);
			}
		}
	});

	it("accepts lang=es without failing", async () => {
		const res = await get("/toc?lang=es");
		expect(res.status).toBe(200);
		const { parts } = (await res.json()).data;
		expect(parts).toBeArray();
		expect(parts.length).toBeGreaterThan(0);
	});
});

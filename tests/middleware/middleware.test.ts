import { describe, expect, it } from "bun:test";
import { get, options } from "../helpers/app.ts";

describe("CORS middleware", () => {
	it("GET / returns Access-Control-Allow-Origin: *", async () => {
		const res = await get("/");
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});

	it("OPTIONS preflight returns CORS headers", async () => {
		const res = await options("/", {
			Origin: "https://example.com",
			"Access-Control-Request-Method": "GET",
		});
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(res.headers.get("access-control-allow-methods")).toContain("GET");
	});
});

describe("Rate limit headers", () => {
	it("responses include rate limit headers", async () => {
		const res = await get("/");
		expect(res.headers.get("x-ratelimit-limit")).toBe("200");
		expect(res.headers.get("x-ratelimit-remaining")).toBeString();
		expect(res.headers.get("x-ratelimit-reset")).toBeString();
	});
});

describe("Cache-Control", () => {
	it("GET / has short cache", async () => {
		const res = await get("/");
		const cc = res.headers.get("cache-control");
		expect(cc).toContain("public");
		expect(cc).toContain("s-maxage=3600");
	});

	it("GET /paragraphs/random has no-store", async () => {
		const res = await get("/paragraphs/random");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("GET /toc revalidates so language overlays are not stuck", async () => {
		const res = await get("/toc");
		const cc = res.headers.get("cache-control");
		expect(cc).toContain("s-maxage=60");
		expect(cc).toContain("max-age=0");
	});
});

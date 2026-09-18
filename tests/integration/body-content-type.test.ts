import { describe, expect, it } from "bun:test";
import { app } from "../../src/index.ts";

/**
 * A body route must validate its body whatever the Content-Type is.
 *
 * @hono/zod-openapi skips the body validator when `request.body.required` is
 * not true and the Content-Type is not JSON. The handler then reads undefined
 * fields and throws a 500. Every body route sets `required: true` to close it.
 */

// Public body routes — the validator runs and rejects the body.
const PUBLIC_BODY_ROUTES: Array<{ method: string; path: string }> = [
	{ method: "POST", path: "/search" },
	{ method: "POST", path: "/search/semantic" },
	{ method: "POST", path: "/bible/search/semantic" },
	{ method: "POST", path: "/auth/token" },
	{ method: "POST", path: "/auth/refresh" },
];

// Body routes behind auth — the 401 lands before the validator.
const AUTHED_BODY_ROUTES: Array<{ method: string; path: string }> = [
	{ method: "PUT", path: "/me" },
	{ method: "POST", path: "/me/bookmarks" },
	{ method: "POST", path: "/me/notes" },
	{ method: "POST", path: "/me/reading-progress" },
	{ method: "PUT", path: "/me/preferences" },
	{ method: "POST", path: "/auth/apps" },
	{ method: "PATCH", path: "/auth/apps/some-id" },
	{ method: "POST", path: "/auth/authorize" },
];

// Content types that skipped validation before the fix.
const CONTENT_TYPES = ["application/x-www-form-urlencoded", "text/plain"];

function send(method: string, path: string, contentType?: string) {
	return app.request(path, {
		method,
		headers: contentType ? { "Content-Type": contentType } : {},
		body: "q=God",
	});
}

describe("body validation ignores the Content-Type", () => {
	for (const { method, path } of PUBLIC_BODY_ROUTES) {
		for (const contentType of CONTENT_TYPES) {
			it(`${method} ${path} returns 400 for ${contentType}`, async () => {
				const res = await send(method, path, contentType);
				expect(res.status).toBe(400);
			});
		}

		it(`${method} ${path} returns 400 for a missing Content-Type`, async () => {
			const res = await send(method, path);
			expect(res.status).toBe(400);
		});
	}

	for (const { method, path } of AUTHED_BODY_ROUTES) {
		// The 401 and the body 400 both come before any handler logic. Either
		// answer is correct. A 500 is the regression this guards.
		it(`${method} ${path} rejects with 400 or 401, never 500`, async () => {
			const res = await send(method, path, CONTENT_TYPES[0]);
			expect([400, 401]).toContain(res.status);
		});
	}
});

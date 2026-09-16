import type { MiddlewareHandler } from "hono";

/**
 * Sets Cache-Control headers based on route pattern.
 * Cloudflare's CDN respects s-maxage for edge caching.
 */
export function cacheControl(): MiddlewareHandler {
	return async (c, next) => {
		await next();

		// Don't cache error responses
		if (c.res.status >= 400) return;

		// If the route handler already set Cache-Control, treat that as authoritative
		// (e.g. /auth/apps/:id/logo sets its own public,max-age=86400 for R2 logos).
		if (c.res.headers.has("cache-control")) return;

		const path = c.req.path;

		if (path.startsWith("/og/")) {
			c.header("Cache-Control", "public, max-age=31536000, immutable");
		} else if (
			path === "/paragraphs/random" ||
			path === "/health" ||
			path.startsWith("/admin/") ||
			path.startsWith("/me/") ||
			path.startsWith("/auth/")
		) {
			// no-store: admin/auth endpoints serve per-user or sensitive data
			// that must not be edge-cached.
			c.header("Cache-Control", "no-store");
		} else if (path === "/search") {
			c.header("Cache-Control", "public, s-maxage=3600, max-age=300");
		} else if (path === "/toc") {
			// Language overlays are re-seeded from metadata.json. A day-long
			// edge cache kept stale English part titles after a language switch.
			c.header("Cache-Control", "public, s-maxage=60, max-age=0, must-revalidate");
		} else if (
			path === "/" ||
			path === "/docs" ||
			path === "/openapi.json"
		) {
			c.header("Cache-Control", "public, s-maxage=3600, max-age=300");
		} else {
			// Static content: /toc, /papers/*, /paragraphs/*, /audio/*
			c.header(
				"Cache-Control",
				"public, s-maxage=86400, max-age=3600, stale-while-revalidate=86400",
			);
		}
	};
}

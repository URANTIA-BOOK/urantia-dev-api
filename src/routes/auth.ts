import { createRoute } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { SignJWT } from "jose";
import { z } from "zod";
import { getDb } from "../db/client.ts";
import { apps, authCodes, refreshTokens, userConsents, users } from "../db/schema.ts";
import { createApp } from "../lib/app.ts";
import { problemJson } from "../lib/errors.ts";
import type { AuthUser } from "../middleware/auth.ts";
import { ErrorResponse } from "../validators/schemas.ts";

export const authRoute = createApp();

// ============================================================
// Helpers
// ============================================================

// The /auth/apps/ prefix is public (the consent screen reads app metadata), so
// the write routes under it reach the handler unauthenticated. Answer 401 with
// the same problem+json shape the auth middleware uses, never a 500.
function getUser(c: { get: (key: "user") => AuthUser | null }): AuthUser {
	const user = c.get("user");
	if (!user) {
		throw new HTTPException(401, {
			res: Response.json(
				{
					type: "https://urantia.dev/errors/unauthorized",
					title: "Unauthorized",
					status: 401,
					detail: "Authentication required. Provide a valid Bearer token.",
				},
				{ status: 401, headers: { "Content-Type": "application/problem+json" } },
			),
		});
	}
	return user;
}

async function sha256(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const data = encoder.encode(codeVerifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return base64 === codeChallenge;
}

function isAdmin(c: { env?: Record<string, unknown> }, userId: string): boolean {
	const adminIds = ((c.env?.ADMIN_USER_IDS as string) ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
	return adminIds.includes(userId);
}

const ALLOWED_SCOPES = ["profile", "bookmarks", "notes", "reading-progress", "preferences", "app-data"];

const REFRESH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Generate a refresh token, hash it, store it, and return the raw token.
 */
async function createRefreshToken(
	db: ReturnType<typeof getDb>["db"],
	userId: string,
	appId: string,
): Promise<string> {
	const rawToken = crypto.randomUUID();
	const tokenHash = await sha256(rawToken);
	const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);

	await db.insert(refreshTokens).values({
		userId,
		appId,
		tokenHash,
		expiresAt,
	});

	return rawToken;
}

/**
 * Dangerous schemes that must never be used as redirect URIs.
 */
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "ftp:", "blob:", "vbscript:"]);

/**
 * Validate a redirect URI.
 * - https:// allowed for any domain
 * - http://localhost:* and http://127.0.0.1:* allowed for development
 * - Custom schemes (e.g. urantiahub://) allowed for native apps
 * - Reject dangerous schemes: javascript:, data:, file:, ftp:, blob:, vbscript:
 */
function validateRedirectUri(uri: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return `Invalid URL: "${uri}"`;
	}
	const { protocol, hostname } = parsed;

	// Block dangerous schemes
	if (BLOCKED_SCHEMES.has(protocol)) {
		return `Blocked scheme "${protocol}" in "${uri}".`;
	}

	// http:// only allowed for localhost
	if (protocol === "http:" && hostname !== "localhost" && hostname !== "127.0.0.1") {
		return `http:// is only allowed for localhost and 127.0.0.1. Use https:// for "${hostname}".`;
	}

	return null;
}

/**
 * Validate an array of redirect URIs. Returns null if all valid, or the first error message.
 */
function validateRedirectUris(uris: string[]): string | null {
	for (const uri of uris) {
		const error = validateRedirectUri(uri);
		if (error) return error;
	}
	return null;
}

// ============================================================
// Schemas
// ============================================================

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #6366f1");

const AppPublicSchema = z.object({
	id: z.string(),
	name: z.string(),
	scopes: z.array(z.string()),
	logoUrl: z.string().nullable(),
	primaryColor: z.string().nullable(),
	accentColor: z.string().nullable(),
});

const AppCreateBody = z.object({
	id: z.string().min(3).max(40).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Must be lowercase alphanumeric with hyphens, 3-40 chars"),
	name: z.string().min(1),
	redirectUris: z.array(z.string().min(1)).min(1),
	scopes: z.array(z.string()).min(1),
	primaryColor: HexColor.optional(),
	accentColor: HexColor.optional(),
});

const AppUpdateBody = z.object({
	name: z.string().min(1).max(100).optional(),
	redirectUris: z.array(z.string().min(1)).min(1).optional(),
	scopes: z.array(z.enum(ALLOWED_SCOPES as [string, ...string[]])).min(1).optional(),
	primaryColor: HexColor.nullable().optional(),
	accentColor: HexColor.nullable().optional(),
}).refine((data) => data.name !== undefined || data.redirectUris !== undefined || data.scopes !== undefined || data.primaryColor !== undefined || data.accentColor !== undefined, {
	message: "At least one field must be provided.",
});

const AppUpdateResponse = z.object({
	id: z.string(),
	name: z.string(),
	redirectUris: z.array(z.string()),
	scopes: z.array(z.string()),
	logoUrl: z.string().nullable(),
	primaryColor: z.string().nullable(),
	accentColor: z.string().nullable(),
	ownerId: z.string().nullable(),
	createdAt: z.string(),
});

const AppListItem = z.object({
	id: z.string(),
	name: z.string(),
	redirectUris: z.array(z.string()),
	scopes: z.array(z.string()),
	logoUrl: z.string().nullable(),
	primaryColor: z.string().nullable(),
	accentColor: z.string().nullable(),
	createdAt: z.string(),
});

const AppCreateResponse = z.object({
	id: z.string(),
	name: z.string(),
	redirectUris: z.array(z.string()),
	scopes: z.array(z.string()),
	secret: z.string(),
});

const AuthorizeBody = z.object({
	appId: z.string().min(1),
	redirectUri: z.string().min(1),
	scopes: z.array(z.string()).min(1),
	codeChallenge: z.string().optional(),
	state: z.string().optional(),
});

const AuthorizeResponse = z.object({
	code: z.string(),
	state: z.string().optional(),
});

const TokenBody = z.object({
	code: z.string().min(1),
	appId: z.string().min(1),
	appSecret: z.string().min(1).optional(),
	codeVerifier: z.string().optional(),
	redirectUri: z.string().optional(),
});

const TokenResponse = z.object({
	accessToken: z.string(),
	refreshToken: z.string(),
	userId: z.string(),
	email: z.string().nullable(),
	scopes: z.array(z.string()),
	expiresAt: z.string(),
});

// ============================================================
// 1. GET /apps/:id — Public app info
// ============================================================

const getAppRoute = createRoute({
	operationId: "getApp",
	method: "get",
	path: "/apps/{id}",
	tags: ["Auth"],
	summary: "Get public app info",
	request: { params: z.object({ id: z.string() }) },
	responses: {
		200: {
			description: "App public info",
			content: { "application/json": { schema: z.object({ data: AppPublicSchema }) } },
		},
		404: {
			description: "App not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

authRoute.openapi(getAppRoute, async (c) => {
	const { id } = c.req.valid("param");
	const { db } = getDb(c.env?.HYPERDRIVE);

	const [app] = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
	if (!app) return problemJson(c, 404, `App "${id}" not found.`);

	return c.json({ data: { id: app.id, name: app.name, scopes: app.scopes, logoUrl: app.logoUrl ?? null, primaryColor: app.primaryColor ?? null, accentColor: app.accentColor ?? null, redirectUris: app.redirectUris, createdAt: app.createdAt.toISOString() } }, 200);
});

// ============================================================
// 2. POST /apps — Register a new app (admin-only)
// ============================================================

const createAppRoute = createRoute({
	operationId: "createApp",
	method: "post",
	path: "/apps",
	tags: ["Auth"],
	summary: "Register a new OAuth app",
	request: { body: { required: true, content: { "application/json": { schema: AppCreateBody } } } },
	responses: {
		201: {
			description: "App created (secret shown once)",
			content: { "application/json": { schema: z.object({ data: AppCreateResponse }) } },
		},
		400: {
			description: "Validation error or duplicate ID",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

authRoute.openapi(createAppRoute, async (c) => {
	const user = getUser(c);
	const body = c.req.valid("json");
	const { db } = getDb(c.env?.HYPERDRIVE);

	// Check for duplicate
	const [existing] = await db.select().from(apps).where(eq(apps.id, body.id)).limit(1);
	if (existing) {
		return problemJson(c, 400, `App with id "${body.id}" already exists.`);
	}

	// Validate redirect URIs
	const uriError = validateRedirectUris(body.redirectUris);
	if (uriError) {
		return problemJson(c, 400, uriError);
	}

	// Generate secret and hash it
	const secret = crypto.randomUUID();
	const secretHash = await sha256(secret);

	await db.insert(apps).values({
		id: body.id,
		name: body.name,
		secretHash,
		redirectUris: body.redirectUris,
		scopes: body.scopes,
		ownerId: user.id,
		primaryColor: body.primaryColor ?? null,
		accentColor: body.accentColor ?? null,
	});

	return c.json(
		{
			data: {
				id: body.id,
				name: body.name,
				redirectUris: body.redirectUris,
				scopes: body.scopes,
				secret,
			},
		},
		201,
	);
});

// ============================================================
// 2B. GET /consent — Check if user has already consented
// ============================================================

const consentCheckRoute = createRoute({
	operationId: "checkConsent",
	method: "get",
	path: "/consent",
	tags: ["Auth"],
	summary: "Check if the user has already consented to an app's scopes",
	request: {
		query: z.object({
			appId: z.string().min(1),
			scopes: z.string().min(1), // comma-separated
		}),
	},
	responses: {
		200: {
			description: "Consent status",
			content: {
				"application/json": {
					schema: z.object({
						data: z.object({
							consented: z.boolean(),
							grantedScopes: z.array(z.string()),
						}),
					}),
				},
			},
		},
	},
});

authRoute.openapi(consentCheckRoute, async (c) => {
	const user = getUser(c);
	const { appId, scopes: scopeStr } = c.req.valid("query");
	const requestedScopes = scopeStr.split(",").map((s) => s.trim()).filter(Boolean);
	const { db } = getDb(c.env?.HYPERDRIVE);

	const [grant] = await db
		.select({ scopes: userConsents.scopes })
		.from(userConsents)
		.where(and(eq(userConsents.userId, user.id), eq(userConsents.appId, appId)))
		.limit(1);

	const grantedScopes = grant?.scopes ?? [];
	const consented = requestedScopes.every((s) => grantedScopes.includes(s));

	return c.json({ data: { consented, grantedScopes } }, 200);
});

// ============================================================
// 3. POST /authorize — Create authorization code
// ============================================================

const authorizeRoute = createRoute({
	operationId: "authorize",
	method: "post",
	path: "/authorize",
	tags: ["Auth"],
	summary: "Create an authorization code (authenticated user)",
	request: { body: { required: true, content: { "application/json": { schema: AuthorizeBody } } } },
	responses: {
		200: {
			description: "Authorization code created",
			content: { "application/json": { schema: z.object({ data: AuthorizeResponse }) } },
		},
		400: {
			description: "Invalid redirect URI or scopes",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "App not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

authRoute.openapi(authorizeRoute, async (c) => {
	const user = getUser(c);
	const body = c.req.valid("json");
	const { db } = getDb(c.env?.HYPERDRIVE);

	// Sync profile from Supabase JWT (may have fresh Google OAuth data)
	if (user.name || user.avatarUrl) {
		const updates: Record<string, unknown> = {};
		if (user.name) updates.name = user.name;
		if (user.avatarUrl) updates.avatarUrl = user.avatarUrl;
		if (user.email) updates.email = user.email;
		await db.update(users).set(updates).where(eq(users.id, user.id));
	}

	// Look up app
	const [app] = await db.select().from(apps).where(eq(apps.id, body.appId)).limit(1);
	if (!app) return problemJson(c, 404, `App "${body.appId}" not found.`);

	// Validate redirect URI
	if (!app.redirectUris.includes(body.redirectUri)) {
		return problemJson(
			c,
			400,
			`Redirect URI "${body.redirectUri}" is not registered for this app.`,
		);
	}

	// Validate scopes are a subset of app's allowed scopes
	const invalidScopes = body.scopes.filter((s) => !app.scopes.includes(s));
	if (invalidScopes.length > 0) {
		return problemJson(
			c,
			400,
			`Invalid scopes: ${invalidScopes.join(", ")}. Allowed: ${app.scopes.join(", ")}.`,
		);
	}

	// Generate auth code with 5-minute expiry
	const code = crypto.randomUUID();
	const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

	await db.insert(authCodes).values({
		code,
		appId: body.appId,
		userId: user.id,
		scopes: body.scopes,
		codeChallenge: body.codeChallenge ?? null,
		redirectUri: body.redirectUri,
		expiresAt,
	});

	// Record/update consent grant (upsert: merge scopes on conflict)
	const [existing] = await db
		.select({ scopes: userConsents.scopes })
		.from(userConsents)
		.where(and(eq(userConsents.userId, user.id), eq(userConsents.appId, body.appId)))
		.limit(1);

	const mergedScopes = existing
		? [...new Set([...existing.scopes, ...body.scopes])]
		: body.scopes;

	if (existing) {
		await db
			.update(userConsents)
			.set({ scopes: mergedScopes, grantedAt: new Date() })
			.where(and(eq(userConsents.userId, user.id), eq(userConsents.appId, body.appId)));
	} else {
		await db.insert(userConsents).values({
			userId: user.id,
			appId: body.appId,
			scopes: body.scopes,
		});
	}

	return c.json({ data: { code, state: body.state } }, 200);
});

// ============================================================
// 4. POST /token — Exchange code for tokens
// ============================================================

const tokenRoute = createRoute({
	operationId: "exchangeToken",
	method: "post",
	path: "/token",
	tags: ["Auth"],
	summary: "Exchange authorization code for tokens",
	request: { body: { required: true, content: { "application/json": { schema: TokenBody } } } },
	responses: {
		200: {
			description: "Token response",
			content: { "application/json": { schema: z.object({ data: TokenResponse }) } },
		},
		400: {
			description: "Invalid, expired, or already-used code",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Invalid app secret",
			content: { "application/json": { schema: ErrorResponse } },
		},
		500: {
			description: "Internal server error",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

authRoute.openapi(tokenRoute, async (c) => {
	const body = c.req.valid("json");
	const { db } = getDb(c.env?.HYPERDRIVE);

	// Look up the auth code
	const [authCode] = await db
		.select()
		.from(authCodes)
		.where(eq(authCodes.code, body.code))
		.limit(1);
	if (!authCode) {
		return problemJson(c, 400, "Invalid or already-used authorization code.");
	}

	// Check expiry
	if (authCode.expiresAt < new Date()) {
		// Clean up expired code
		await db.delete(authCodes).where(eq(authCodes.code, body.code));
		return problemJson(c, 400, "Authorization code has expired.");
	}

	// Verify appId matches
	if (authCode.appId !== body.appId) {
		return problemJson(c, 400, "App ID does not match the authorization code.");
	}

	// RFC 6749: re-validate redirect_uri on token exchange
	if (body.redirectUri) {
		if (body.redirectUri !== authCode.redirectUri) {
			await db.delete(authCodes).where(eq(authCodes.code, body.code));
			return problemJson(c, 400, "Redirect URI does not match the one used during authorization.");
		}
	}

	// Look up the app and verify secret
	const [app] = await db.select().from(apps).where(eq(apps.id, body.appId)).limit(1);
	if (!app) {
		return problemJson(c, 400, "App not found.");
	}

	// Verify app secret if provided
	if (body.appSecret) {
		const secretHash = await sha256(body.appSecret);
		if (secretHash !== app.secretHash) {
			return problemJson(c, 401, "Invalid app secret.");
		}
	}

	// PKCE verification
	if (authCode.codeChallenge) {
		if (!body.codeVerifier) {
			return problemJson(c, 400, "Code verifier is required for PKCE.");
		}
		const valid = await verifyPkce(body.codeVerifier, authCode.codeChallenge);
		if (!valid) {
			return problemJson(c, 400, "PKCE verification failed.");
		}
	}

	// Require at least one auth method
	if (!body.appSecret && !authCode.codeChallenge) {
		return problemJson(c, 400, "Either appSecret or PKCE code_challenge is required.");
	}

	// Delete the code (one-time use)
	await db.delete(authCodes).where(eq(authCodes.code, body.code));

	// Look up user email from users table
	const [user] = await db
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, authCode.userId))
		.limit(1);

	// Generate a scoped JWT access token (7-day expiry)
	const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

	const jwtSecret = c.env?.APP_JWT_SECRET as string;
	if (!jwtSecret) {
		return problemJson(c, 500, "JWT signing key not configured.");
	}

	const secret = new TextEncoder().encode(jwtSecret);
	const accessToken = await new SignJWT({
		sub: authCode.userId,
		email: user?.email ?? null,
		scopes: authCode.scopes,
		app_id: authCode.appId,
		iss: "https://accounts.urantiahub.com",
		aud: "authenticated",
	})
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime(expiresAt)
		.sign(secret);

	// Generate refresh token
	const refreshToken = await createRefreshToken(db, authCode.userId, authCode.appId);

	return c.json(
		{
			data: {
				accessToken,
				refreshToken,
				userId: authCode.userId,
				email: user?.email ?? null,
				scopes: authCode.scopes,
				expiresAt: expiresAt.toISOString(),
			},
		},
		200,
	);
});

// ============================================================
// 4B. POST /refresh — Refresh access token
// ============================================================

const RefreshBody = z.object({
	refreshToken: z.string().min(1),
	appId: z.string().min(1),
});

const refreshRoute = createRoute({
	operationId: "refreshToken",
	method: "post",
	path: "/refresh",
	tags: ["Auth"],
	summary: "Exchange a refresh token for a new access token + refresh token",
	request: { body: { required: true, content: { "application/json": { schema: RefreshBody } } } },
	responses: {
		200: {
			description: "New token pair",
			content: { "application/json": { schema: z.object({ data: TokenResponse }) } },
		},
		400: {
			description: "Invalid or expired refresh token",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Refresh token reused (theft detected) — all tokens revoked",
			content: { "application/json": { schema: ErrorResponse } },
		},
		500: {
			description: "Internal server error",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

authRoute.openapi(refreshRoute, async (c) => {
	const body = c.req.valid("json");
	const { db } = getDb(c.env?.HYPERDRIVE);
	const logger = c.get("logger");

	const tokenHash = await sha256(body.refreshToken);

	// Find the refresh token by hash
	const [token] = await db
		.select()
		.from(refreshTokens)
		.where(and(eq(refreshTokens.tokenHash, tokenHash), eq(refreshTokens.appId, body.appId)))
		.limit(1);

	if (!token) {
		return problemJson(c, 400, "Invalid refresh token.");
	}

	// Check if this token was already consumed (theft detection)
	if (token.consumed) {
		// Token reuse detected — revoke ALL refresh tokens for this user+app
		logger?.warn("[auth] Refresh token reuse detected — revoking all tokens", {
			userId: token.userId,
			appId: token.appId,
			reusedTokenId: token.id,
		});
		await db
			.delete(refreshTokens)
			.where(and(eq(refreshTokens.userId, token.userId), eq(refreshTokens.appId, token.appId)));
		return problemJson(c, 401, "Refresh token has already been used. All sessions revoked for security.");
	}

	// Check expiry
	if (token.expiresAt < new Date()) {
		await db.delete(refreshTokens).where(eq(refreshTokens.id, token.id));
		return problemJson(c, 400, "Refresh token has expired. Please sign in again.");
	}

	// Mark as consumed (keep for theft detection, don't delete yet)
	await db
		.update(refreshTokens)
		.set({ consumed: new Date() })
		.where(eq(refreshTokens.id, token.id));

	// Look up user
	const [user] = await db
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, token.userId))
		.limit(1);

	// Look up app scopes from the consent grant
	const [consent] = await db
		.select({ scopes: userConsents.scopes })
		.from(userConsents)
		.where(and(eq(userConsents.userId, token.userId), eq(userConsents.appId, token.appId)))
		.limit(1);

	const scopes = consent?.scopes ?? ["profile"];

	// Generate new access token
	const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

	const jwtSecret = c.env?.APP_JWT_SECRET as string;
	if (!jwtSecret) {
		return problemJson(c, 500, "JWT signing key not configured.");
	}

	const secret = new TextEncoder().encode(jwtSecret);
	const accessToken = await new SignJWT({
		sub: token.userId,
		email: user?.email ?? null,
		scopes,
		app_id: token.appId,
		iss: "https://accounts.urantiahub.com",
		aud: "authenticated",
	})
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime(expiresAt)
		.sign(secret);

	// Issue new refresh token (rotation)
	const newRefreshToken = await createRefreshToken(db, token.userId, token.appId);

	// Clean up old consumed tokens for this user+app (keep last 5 for theft detection window)
	const oldTokens = await db
		.select({ id: refreshTokens.id })
		.from(refreshTokens)
		.where(
			and(
				eq(refreshTokens.userId, token.userId),
				eq(refreshTokens.appId, token.appId),
			),
		)
		.orderBy(refreshTokens.createdAt);

	if (oldTokens.length > 5) {
		const toDelete = oldTokens.slice(0, oldTokens.length - 5);
		for (const old of toDelete) {
			await db.delete(refreshTokens).where(eq(refreshTokens.id, old.id));
		}
	}

	return c.json(
		{
			data: {
				accessToken,
				refreshToken: newRefreshToken,
				userId: token.userId,
				email: user?.email ?? null,
				scopes,
				expiresAt: expiresAt.toISOString(),
			},
		},
		200,
	);
});

// ============================================================
// 5. GET /apps — List my apps
// ============================================================

const listAppsRoute = createRoute({
	operationId: "listMyApps",
	method: "get",
	path: "/apps",
	tags: ["Auth"],
	summary: "List OAuth apps owned by the authenticated user",
	responses: {
		200: {
			description: "List of apps",
			content: { "application/json": { schema: z.object({ data: z.array(AppListItem) }) } },
		},
	},
});

authRoute.openapi(listAppsRoute, async (c) => {
	const user = getUser(c);
	const { db } = getDb(c.env?.HYPERDRIVE);

	const results = await db
		.select({
			id: apps.id,
			name: apps.name,
			redirectUris: apps.redirectUris,
			scopes: apps.scopes,
			logoUrl: apps.logoUrl,
			primaryColor: apps.primaryColor,
			accentColor: apps.accentColor,
			createdAt: apps.createdAt,
		})
		.from(apps)
		.where(eq(apps.ownerId, user.id));

	return c.json({
		data: results.map((app) => ({
			...app,
			logoUrl: app.logoUrl ?? null,
			primaryColor: app.primaryColor ?? null,
			accentColor: app.accentColor ?? null,
			createdAt: app.createdAt.toISOString(),
		})),
	}, 200);
});

// ============================================================
// 6. DELETE /apps/:id — Delete my app
// ============================================================

const deleteAppRoute = createRoute({
	operationId: "deleteApp",
	method: "delete",
	path: "/apps/{id}",
	tags: ["Auth"],
	summary: "Delete an OAuth app (owner-only)",
	request: { params: z.object({ id: z.string() }) },
	responses: {
		204: { description: "App deleted" },
		403: {
			description: "Not the app owner",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "App not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

authRoute.openapi(deleteAppRoute, async (c) => {
	const user = getUser(c);
	const { id } = c.req.valid("param");
	const { db } = getDb(c.env?.HYPERDRIVE);

	const [app] = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
	if (!app) return problemJson(c, 404, `App "${id}" not found.`);

	if (app.ownerId !== user.id && !isAdmin(c, user.id)) {
		return problemJson(c, 403, "You do not own this app.");
	}

	await db.delete(apps).where(eq(apps.id, id));
	return c.body(null, 204);
});

// ============================================================
// 7. POST /apps/:id/rotate-secret — Rotate app secret
// ============================================================

const rotateSecretRoute = createRoute({
	operationId: "rotateAppSecret",
	method: "post",
	path: "/apps/{id}/rotate-secret",
	tags: ["Auth"],
	summary: "Rotate the app secret (owner-only)",
	request: { params: z.object({ id: z.string() }) },
	responses: {
		200: {
			description: "New secret (shown once)",
			content: { "application/json": { schema: z.object({ data: z.object({ secret: z.string() }) }) } },
		},
		403: {
			description: "Not the app owner",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "App not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

authRoute.openapi(rotateSecretRoute, async (c) => {
	const user = getUser(c);
	const { id } = c.req.valid("param");
	const { db } = getDb(c.env?.HYPERDRIVE);

	const [app] = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
	if (!app) return problemJson(c, 404, `App "${id}" not found.`);

	if (app.ownerId !== user.id && !isAdmin(c, user.id)) {
		return problemJson(c, 403, "You do not own this app.");
	}

	const secret = crypto.randomUUID();
	const secretHash = await sha256(secret);

	await db.update(apps).set({ secretHash }).where(eq(apps.id, id));

	return c.json({ data: { secret } }, 200);
});

// ============================================================
// 8. PATCH /apps/:id — Update my app
// ============================================================

const updateAppRoute = createRoute({
	operationId: "updateApp",
	method: "patch",
	path: "/apps/{id}",
	tags: ["Auth"],
	summary: "Update an OAuth app (owner-only)",
	request: {
		params: z.object({ id: z.string() }),
		body: { required: true, content: { "application/json": { schema: AppUpdateBody } } },
	},
	responses: {
		200: {
			description: "App updated",
			content: { "application/json": { schema: z.object({ data: AppUpdateResponse }) } },
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Not authenticated",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Not the app owner",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "App not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

authRoute.openapi(updateAppRoute, async (c) => {
	const user = getUser(c);
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const { db } = getDb(c.env?.HYPERDRIVE);
	const logger = c.get("logger");

	// Look up the app
	const [app] = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
	if (!app) return problemJson(c, 404, `App "${id}" not found.`);

	// Owner check
	if (app.ownerId !== user.id && !isAdmin(c, user.id)) {
		return problemJson(c, 403, "You do not own this app.");
	}

	// Validate redirect URIs if provided
	if (body.redirectUris) {
		const uriError = validateRedirectUris(body.redirectUris);
		if (uriError) {
			return problemJson(c, 400, uriError);
		}
	}

	// Build the update payload (only fields that were provided)
	const updates: Partial<{ name: string; redirectUris: string[]; scopes: string[]; primaryColor: string | null; accentColor: string | null }> = {};
	if (body.name !== undefined) updates.name = body.name;
	if (body.redirectUris !== undefined) updates.redirectUris = body.redirectUris;
	if (body.scopes !== undefined) updates.scopes = body.scopes;
	if (body.primaryColor !== undefined) updates.primaryColor = body.primaryColor;
	if (body.accentColor !== undefined) updates.accentColor = body.accentColor;

	// Log the before/after
	const before = { name: app.name, redirectUris: app.redirectUris, scopes: app.scopes };
	logger?.info(`[auth] PATCH /apps/${id}`, { before, after: updates, userId: user.id });

	// Apply the update
	await db.update(apps).set(updates).where(eq(apps.id, id));

	// If scopes changed, invalidate all existing auth codes for this app
	if (body.scopes !== undefined) {
		const deleted = await db.delete(authCodes).where(eq(authCodes.appId, id));
		logger?.info(`[auth] Scopes changed for app "${id}", deleted auth codes`, {
			appId: id,
			deletedCount: deleted.length,
		});
	}

	// Fetch the updated app to return
	const [updated] = await db.select().from(apps).where(eq(apps.id, id)).limit(1);

	return c.json(
		{
			data: {
				id: updated!.id,
				name: updated!.name,
				redirectUris: updated!.redirectUris,
				scopes: updated!.scopes,
				logoUrl: updated!.logoUrl ?? null,
				primaryColor: updated!.primaryColor ?? null,
				accentColor: updated!.accentColor ?? null,
				ownerId: updated!.ownerId,
				createdAt: updated!.createdAt.toISOString(),
			},
		},
		200,
	);
});

// ============================================================
// 9. POST /apps/:id/logo — Upload app logo (owner-only)
// ============================================================

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_LOGO_SIZE = 2 * 1024 * 1024; // 2MB

const uploadLogoRoute = createRoute({
	operationId: "uploadAppLogo",
	method: "post",
	path: "/apps/{id}/logo",
	tags: ["Auth"],
	summary: "Upload an app logo (owner-only, max 2MB, PNG/JPEG/WebP)",
	request: {
		params: z.object({ id: z.string() }),
		body: { required: true, content: { "multipart/form-data": { schema: z.object({ logo: z.any() }) } } },
	},
	responses: {
		200: {
			description: "Logo uploaded",
			content: { "application/json": { schema: z.object({ data: z.object({ logoUrl: z.string() }) }) } },
		},
		400: {
			description: "Invalid file",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Not the app owner",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "App not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		500: {
			description: "Internal server error",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

authRoute.openapi(uploadLogoRoute, async (c) => {
	const user = getUser(c);
	const { id } = c.req.valid("param");
	const { db } = getDb(c.env?.HYPERDRIVE);

	// Look up app and verify ownership
	const [app] = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
	if (!app) return problemJson(c, 404, `App "${id}" not found.`);
	if (app.ownerId !== user.id && !isAdmin(c, user.id)) {
		return problemJson(c, 403, "You do not own this app.");
	}

	// Get R2 bucket
	const bucket = c.env?.APP_LOGOS;
	if (!bucket) return problemJson(c, 500, "Logo storage not configured.");

	// Parse multipart form
	const formData = await c.req.formData();
	const raw = formData.get("logo");
	if (!raw || typeof raw === "string") {
		return problemJson(c, 400, 'Missing "logo" file in form data.');
	}
	const file = raw as unknown as File;

	// Validate MIME type
	if (!ALLOWED_MIME_TYPES.includes(file.type)) {
		return problemJson(c, 400, `Invalid file type "${file.type}". Allowed: PNG, JPEG, WebP.`);
	}

	// Validate size
	if (file.size > MAX_LOGO_SIZE) {
		return problemJson(c, 400, `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max: 2MB.`);
	}

	// Determine extension from MIME type
	const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
	const key = `${id}/logo.${ext}`;

	// Upload to R2
	const arrayBuffer = await file.arrayBuffer();
	await bucket.put(key, arrayBuffer, {
		httpMetadata: { contentType: file.type, cacheControl: "public, max-age=86400" },
	});

	// Build the public URL (served via GET /auth/apps/:id/logo)
	const logoUrl = `https://api.urantia.dev/auth/apps/${id}/logo`;

	// Update the database
	await db.update(apps).set({ logoUrl }).where(eq(apps.id, id));

	return c.json({ data: { logoUrl } }, 200);
});

// ============================================================
// 10. DELETE /apps/:id/logo — Remove app logo (owner-only)
// ============================================================

const deleteLogoRoute = createRoute({
	operationId: "deleteAppLogo",
	method: "delete",
	path: "/apps/{id}/logo",
	tags: ["Auth"],
	summary: "Remove an app logo (owner-only)",
	request: { params: z.object({ id: z.string() }) },
	responses: {
		204: { description: "Logo removed" },
		403: {
			description: "Not the app owner",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "App not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

authRoute.openapi(deleteLogoRoute, async (c) => {
	const user = getUser(c);
	const { id } = c.req.valid("param");
	const { db } = getDb(c.env?.HYPERDRIVE);

	const [app] = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
	if (!app) return problemJson(c, 404, `App "${id}" not found.`);
	if (app.ownerId !== user.id && !isAdmin(c, user.id)) {
		return problemJson(c, 403, "You do not own this app.");
	}

	const bucket = c.env?.APP_LOGOS;
	if (bucket) {
		// Delete all possible extensions
		await Promise.all([
			bucket.delete(`${id}/logo.png`),
			bucket.delete(`${id}/logo.jpg`),
			bucket.delete(`${id}/logo.webp`),
		]);
	}

	await db.update(apps).set({ logoUrl: null }).where(eq(apps.id, id));
	return c.body(null, 204);
});

// ============================================================
// 11. GET /apps/:id/logo — Serve app logo from R2 (public)
// ============================================================

const getLogoRoute = createRoute({
	operationId: "getAppLogo",
	method: "get",
	path: "/apps/{id}/logo",
	tags: ["Auth"],
	summary: "Get app logo image (public)",
	request: { params: z.object({ id: z.string() }) },
	responses: {
		200: { description: "Logo image" },
		404: {
			description: "No logo found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

authRoute.openapi(getLogoRoute, async (c) => {
	const { id } = c.req.valid("param");
	const bucket = c.env?.APP_LOGOS;
	if (!bucket) return problemJson(c, 404, "No logo found.");

	// Try each extension
	for (const ext of ["png", "jpg", "webp"]) {
		const object = await bucket.get(`${id}/logo.${ext}`);
		if (object) {
			const headers = new Headers();
			headers.set("Content-Type", object.httpMetadata?.contentType ?? "image/png");
			headers.set("Cache-Control", "public, max-age=86400");
			headers.set("ETag", object.httpEtag);
			return new Response(object.body as ReadableStream, { status: 200, headers });
		}
	}

	return problemJson(c, 404, "No logo found.");
});

// ============================================================
// 12. GET /admin/check — Check if user is admin
// ============================================================

const adminCheckRoute = createRoute({
	operationId: "adminCheck",
	method: "get",
	path: "/admin/check",
	tags: ["Admin"],
	summary: "Check if the authenticated user is an admin",
	responses: {
		200: {
			description: "Admin status",
			content: { "application/json": { schema: z.object({ data: z.object({ isAdmin: z.boolean() }) }) } },
		},
	},
});

authRoute.openapi(adminCheckRoute, async (c) => {
	const user = getUser(c);
	return c.json({ data: { isAdmin: isAdmin(c, user.id) } }, 200);
});

// ============================================================
// 13. GET /admin/apps — List all apps (admin-only)
// ============================================================

const AdminAppListItem = z.object({
	id: z.string(),
	name: z.string(),
	redirectUris: z.array(z.string()),
	scopes: z.array(z.string()),
	logoUrl: z.string().nullable(),
	primaryColor: z.string().nullable(),
	accentColor: z.string().nullable(),
	ownerId: z.string().nullable(),
	ownerEmail: z.string().nullable(),
	createdAt: z.string(),
});

const adminListAppsRoute = createRoute({
	operationId: "adminListApps",
	method: "get",
	path: "/admin/apps",
	tags: ["Admin"],
	summary: "List all OAuth apps (admin-only)",
	responses: {
		200: {
			description: "All apps with owner info",
			content: { "application/json": { schema: z.object({ data: z.array(AdminAppListItem) }) } },
		},
		403: {
			description: "Not an admin",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

authRoute.openapi(adminListAppsRoute, async (c) => {
	const user = getUser(c);
	if (!isAdmin(c, user.id)) {
		return problemJson(c, 403, "Admin access required.");
	}

	const { db } = getDb(c.env?.HYPERDRIVE);

	const results = await db
		.select({
			id: apps.id,
			name: apps.name,
			redirectUris: apps.redirectUris,
			scopes: apps.scopes,
			logoUrl: apps.logoUrl,
			primaryColor: apps.primaryColor,
			accentColor: apps.accentColor,
			ownerId: apps.ownerId,
			ownerEmail: users.email,
			createdAt: apps.createdAt,
		})
		.from(apps)
		.leftJoin(users, eq(apps.ownerId, users.id))
		.orderBy(apps.createdAt);

	return c.json({
		data: results.map((row) => ({
			...row,
			logoUrl: row.logoUrl ?? null,
			primaryColor: row.primaryColor ?? null,
			accentColor: row.accentColor ?? null,
			ownerEmail: row.ownerEmail ?? null,
			createdAt: row.createdAt.toISOString(),
		})),
	}, 200);
});

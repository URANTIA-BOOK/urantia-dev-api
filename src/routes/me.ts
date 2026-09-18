import { createRoute } from "@hono/zod-openapi";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/client.ts";
import { bookmarks, notes, paragraphs, readingProgress, userPreferences, users } from "../db/schema.ts";
import { createApp } from "../lib/app.ts";
import { problemJson } from "../lib/errors.ts";
import { lookupParagraphs, resolveParagraphRef } from "../lib/paragraph-lookup.ts";
import type { AuthUser } from "../middleware/auth.ts";
import { ErrorResponse, ParagraphSchema } from "../validators/schemas.ts";
import {
	BookmarkCreate,
	BookmarkResponse,
	NoteCreate,
	NoteResponse,
	NoteUpdate,
	PaginationQuery,
	PreferencesUpdate,
	ReadingProgressBatch,
	ReadingProgressSummaryResponse,
	UserProfile,
	UserUpdate,
} from "../validators/me-schemas.ts";

export const meRoute = createApp();

function getUser(c: { get: (key: "user") => AuthUser | null }): AuthUser {
	const user = c.get("user");
	if (!user) throw new Error("User not authenticated");
	return user;
}

// ============================================================
// Profile (#2: GET /me reads from DB, not JWT context)
// ============================================================

const getProfileRoute = createRoute({
	operationId: "getProfile",
	method: "get",
	path: "/",
	tags: ["User"],
	summary: "Get authenticated user profile",
	responses: {
		200: { description: "User profile", content: { "application/json": { schema: z.object({ data: UserProfile }) } } },
		401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "User not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

meRoute.openapi(getProfileRoute, async (c) => {
	const user = getUser(c);
	const { db } = getDb(c.env?.HYPERDRIVE);
	const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
	if (!row) return problemJson(c, 404, "User not found.");
	return c.json({ data: { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatarUrl } }, 200);
});

const updateProfileRoute = createRoute({
	operationId: "updateProfile",
	method: "put",
	path: "/",
	tags: ["User"],
	summary: "Update user profile",
	request: { body: { required: true, content: { "application/json": { schema: UserUpdate } } } },
	responses: {
		200: { description: "Updated profile", content: { "application/json": { schema: z.object({ data: UserProfile }) } } },
		401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponse } } },
	},
});

meRoute.openapi(updateProfileRoute, async (c) => {
	const user = getUser(c);
	const body = c.req.valid("json");
	const { db } = getDb(c.env?.HYPERDRIVE);

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (body.name !== undefined) updates.name = body.name;
	if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;

	const [updated] = await db.update(users).set(updates).where(eq(users.id, user.id)).returning();
	return c.json({ data: { id: updated!.id, email: updated!.email, name: updated!.name, avatarUrl: updated!.avatarUrl } }, 200);
});

// ============================================================
// Bookmarks (#1: categories with totals, #5: null category, #11: sorted by sortId)
// ============================================================

const listBookmarksRoute = createRoute({
	operationId: "listBookmarks",
	method: "get",
	path: "/bookmarks",
	tags: ["Bookmarks"],
	summary: "List bookmarks",
	request: { query: PaginationQuery.extend({ paperId: z.string().optional(), category: z.string().optional() }) },
	responses: {
		200: {
			description: "Bookmark list",
			content: { "application/json": { schema: z.object({ data: z.array(BookmarkResponse), pagination: z.object({ page: z.number(), limit: z.number(), total: z.number() }) }) } },
		},
		401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponse } } },
	},
});

meRoute.openapi(listBookmarksRoute, async (c) => {
	const user = getUser(c);
	const { page = 0, limit = 20, paperId, category } = c.req.valid("query");
	const { db } = getDb(c.env?.HYPERDRIVE);

	const conditions = [eq(bookmarks.userId, user.id)];
	if (paperId) conditions.push(eq(bookmarks.paperId, paperId));
	if (category) conditions.push(eq(bookmarks.category, category));
	const where = and(...conditions);

	// Join with paragraphs to sort by sortId
	const [rows, countResult] = await Promise.all([
		db
			.select({ bookmark: bookmarks, sortId: paragraphs.sortId })
			.from(bookmarks)
			.leftJoin(paragraphs, eq(bookmarks.paragraphId, paragraphs.id))
			.where(where)
			.orderBy(paragraphs.sortId)
			.limit(limit)
			.offset(page * limit),
		db.select({ value: count() }).from(bookmarks).where(where),
	]);
	const total = countResult[0]!.value;

	const globalIds = rows.map((r) => r.bookmark.paragraphId);
	const paragraphMap = await lookupParagraphs(db, globalIds);

	const data = rows
		.filter((r) => paragraphMap.has(r.bookmark.paragraphId))
		.map((r) => ({
			id: r.bookmark.id,
			category: r.bookmark.category,
			createdAt: r.bookmark.createdAt.toISOString(),
			updatedAt: r.bookmark.updatedAt.toISOString(),
			paragraph: paragraphMap.get(r.bookmark.paragraphId)!,
		}));

	return c.json({ data, pagination: { page, limit, total } }, 200);
});

const listBookmarkCategoriesRoute = createRoute({
	operationId: "listBookmarkCategories",
	method: "get",
	path: "/bookmarks/categories",
	tags: ["Bookmarks"],
	summary: "List bookmark categories with counts and refs",
	responses: {
		200: {
			description: "Category list with counts",
			content: {
				"application/json": {
					schema: z.object({
						data: z.array(z.object({
							category: z.string().nullable(),
							count: z.number(),
							refs: z.array(z.string()),
						})),
					}),
				},
			},
		},
		401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponse } } },
	},
});

meRoute.openapi(listBookmarkCategoriesRoute, async (c) => {
	const user = getUser(c);
	const { db } = getDb(c.env?.HYPERDRIVE);

	// Get categories with counts and refs, ordered by paragraph sortId within each category
	const rows = await db
		.select({
			category: bookmarks.category,
			paragraphId: bookmarks.paragraphId,
			sortId: paragraphs.sortId,
		})
		.from(bookmarks)
		.leftJoin(paragraphs, eq(bookmarks.paragraphId, paragraphs.id))
		.where(eq(bookmarks.userId, user.id))
		.orderBy(paragraphs.sortId);

	// Group by category
	const categoryMap = new Map<string | null, string[]>();
	for (const row of rows) {
		const key = row.category;
		if (!categoryMap.has(key)) categoryMap.set(key, []);
		categoryMap.get(key)!.push(row.paragraphId);
	}

	const data = Array.from(categoryMap.entries()).map(([category, refs]) => ({
		category,
		count: refs.length,
		refs,
	}));

	return c.json({ data }, 200);
});

const createBookmarkRoute = createRoute({
	operationId: "createBookmark",
	method: "post",
	path: "/bookmarks",
	tags: ["Bookmarks"],
	summary: "Create a bookmark (idempotent)",
	description: "Pass any paragraph reference format. If already bookmarked, updates the category and returns 200.",
	request: { body: { required: true, content: { "application/json": { schema: BookmarkCreate } } } },
	responses: {
		200: { description: "Bookmark already exists (updated category if provided)", content: { "application/json": { schema: z.object({ data: BookmarkResponse }) } } },
		201: { description: "Bookmark created", content: { "application/json": { schema: z.object({ data: BookmarkResponse }) } } },
		401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Paragraph not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

meRoute.openapi(createBookmarkRoute, async (c) => {
	const user = getUser(c);
	const { ref, category } = c.req.valid("json");
	const { db } = getDb(c.env?.HYPERDRIVE);

	const resolved = await resolveParagraphRef(db, ref);
	if (!resolved) return problemJson(c, 404, `Paragraph "${ref}" not found.`);

	const [existing] = await db
		.select()
		.from(bookmarks)
		.where(and(eq(bookmarks.userId, user.id), eq(bookmarks.paragraphId, resolved.globalId)))
		.limit(1);

	if (existing) {
		if (category !== undefined && category !== existing.category) {
			await db.update(bookmarks).set({ category, updatedAt: new Date() }).where(eq(bookmarks.id, existing.id));
			existing.category = category;
			existing.updatedAt = new Date();
		}
		return c.json({
			data: {
				id: existing.id,
				category: existing.category,
				createdAt: existing.createdAt.toISOString(),
				updatedAt: existing.updatedAt.toISOString(),
				paragraph: resolved.paragraph,
			},
		}, 200);
	}

	const [created] = await db
		.insert(bookmarks)
		.values({
			userId: user.id,
			paragraphId: resolved.globalId,
			paperId: resolved.paperId,
			paperSectionId: resolved.paperSectionId,
			paperSectionParagraphId: resolved.paperSectionParagraphId,
			category: category ?? null,
		})
		.returning();

	return c.json({
		data: {
			id: created!.id,
			category: created!.category,
			createdAt: created!.createdAt.toISOString(),
			updatedAt: created!.updatedAt.toISOString(),
			paragraph: resolved.paragraph,
		},
	}, 201);
});

const deleteBookmarkRoute = createRoute({
	operationId: "deleteBookmark",
	method: "delete",
	path: "/bookmarks/{ref}",
	tags: ["Bookmarks"],
	summary: "Delete a bookmark by paragraph reference",
	request: { params: z.object({ ref: z.string() }) },
	responses: {
		204: { description: "Bookmark deleted" },
		401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Paragraph or bookmark not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

meRoute.openapi(deleteBookmarkRoute, async (c) => {
	const user = getUser(c);
	const { ref } = c.req.valid("param");
	const { db } = getDb(c.env?.HYPERDRIVE);

	const resolved = await resolveParagraphRef(db, ref);
	if (!resolved) return problemJson(c, 404, `Paragraph "${ref}" not found.`);

	const deleted = await db
		.delete(bookmarks)
		.where(and(eq(bookmarks.userId, user.id), eq(bookmarks.paragraphId, resolved.globalId)))
		.returning();
	if (deleted.length === 0) return problemJson(c, 404, "Bookmark not found.");
	return c.body(null, 204);
});

// ============================================================
// Notes (#6: ref query param, #11: sorted by sortId)
// ============================================================

const listNotesRoute = createRoute({
	operationId: "listNotes",
	method: "get",
	path: "/notes",
	tags: ["Notes"],
	summary: "List notes",
	request: { query: PaginationQuery.extend({ paperId: z.string().optional(), ref: z.string().optional() }) },
	responses: {
		200: {
			description: "Note list",
			content: { "application/json": { schema: z.object({ data: z.array(NoteResponse), pagination: z.object({ page: z.number(), limit: z.number(), total: z.number() }) }) } },
		},
		401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponse } } },
	},
});

meRoute.openapi(listNotesRoute, async (c) => {
	const user = getUser(c);
	const { page = 0, limit = 20, paperId, ref } = c.req.valid("query");
	const { db } = getDb(c.env?.HYPERDRIVE);

	const conditions = [eq(notes.userId, user.id)];
	if (paperId) conditions.push(eq(notes.paperId, paperId));
	if (ref) {
		const resolved = await resolveParagraphRef(db, ref);
		if (resolved) conditions.push(eq(notes.paragraphId, resolved.globalId));
	}
	const where = and(...conditions);

	const [rows, countResult] = await Promise.all([
		db
			.select({ note: notes, sortId: paragraphs.sortId })
			.from(notes)
			.leftJoin(paragraphs, eq(notes.paragraphId, paragraphs.id))
			.where(where)
			.orderBy(paragraphs.sortId)
			.limit(limit)
			.offset(page * limit),
		db.select({ value: count() }).from(notes).where(where),
	]);
	const total = countResult[0]!.value;

	const globalIds = rows.map((r) => r.note.paragraphId);
	const paragraphMap = await lookupParagraphs(db, globalIds);

	const data = rows
		.filter((r) => paragraphMap.has(r.note.paragraphId))
		.map((r) => ({
			id: r.note.id,
			text: r.note.text,
			format: r.note.format,
			createdAt: r.note.createdAt.toISOString(),
			updatedAt: r.note.updatedAt.toISOString(),
			paragraph: paragraphMap.get(r.note.paragraphId)!,
		}));

	return c.json({ data, pagination: { page, limit, total } }, 200);
});

const createNoteRoute = createRoute({
	operationId: "createNote",
	method: "post",
	path: "/notes",
	tags: ["Notes"],
	summary: "Create a note",
	description: "Pass any paragraph reference format. Multiple notes per paragraph are allowed. Format: 'plain' (default) or 'markdown'.",
	request: { body: { required: true, content: { "application/json": { schema: NoteCreate } } } },
	responses: {
		201: { description: "Note created", content: { "application/json": { schema: z.object({ data: NoteResponse }) } } },
		401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Paragraph not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

meRoute.openapi(createNoteRoute, async (c) => {
	const user = getUser(c);
	const { ref, text, format } = c.req.valid("json");
	const { db } = getDb(c.env?.HYPERDRIVE);

	const resolved = await resolveParagraphRef(db, ref);
	if (!resolved) return problemJson(c, 404, `Paragraph "${ref}" not found.`);

	const [created] = await db
		.insert(notes)
		.values({
			userId: user.id,
			paragraphId: resolved.globalId,
			paperId: resolved.paperId,
			paperSectionId: resolved.paperSectionId,
			paperSectionParagraphId: resolved.paperSectionParagraphId,
			text,
			format: format ?? "plain",
		})
		.returning();

	return c.json({
		data: {
			id: created!.id,
			text: created!.text,
			format: created!.format,
			createdAt: created!.createdAt.toISOString(),
			updatedAt: created!.updatedAt.toISOString(),
			paragraph: resolved.paragraph,
		},
	}, 201);
});

const updateNoteRoute = createRoute({
	operationId: "updateNote",
	method: "put",
	path: "/notes/{id}",
	tags: ["Notes"],
	summary: "Update a note",
	request: { params: z.object({ id: z.string().uuid() }), body: { required: true, content: { "application/json": { schema: NoteUpdate } } } },
	responses: {
		200: { description: "Note updated", content: { "application/json": { schema: z.object({ data: NoteResponse }) } } },
		401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Note not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

meRoute.openapi(updateNoteRoute, async (c) => {
	const user = getUser(c);
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const { db } = getDb(c.env?.HYPERDRIVE);

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (body.text !== undefined) updates.text = body.text;
	if (body.format !== undefined) updates.format = body.format;

	const [updated] = await db.update(notes).set(updates).where(and(eq(notes.id, id), eq(notes.userId, user.id))).returning();
	if (!updated) return problemJson(c, 404, "Note not found.");

	const paragraphMap = await lookupParagraphs(db, [updated.paragraphId]);
	return c.json({
		data: {
			id: updated.id,
			text: updated.text,
			format: updated.format,
			createdAt: updated.createdAt.toISOString(),
			updatedAt: updated.updatedAt.toISOString(),
			...(paragraphMap.has(updated.paragraphId) ? { paragraph: paragraphMap.get(updated.paragraphId)! } : {}),
		},
	}, 200);
});

const deleteNoteRoute = createRoute({
	operationId: "deleteNoteById",
	method: "delete",
	path: "/notes/{id}",
	tags: ["Notes"],
	summary: "Delete a note by ID",
	request: { params: z.object({ id: z.string().uuid() }) },
	responses: {
		204: { description: "Note deleted" },
		401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Note not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

meRoute.openapi(deleteNoteRoute, async (c) => {
	const user = getUser(c);
	const { id } = c.req.valid("param");
	const { db } = getDb(c.env?.HYPERDRIVE);
	const deleted = await db.delete(notes).where(and(eq(notes.id, id), eq(notes.userId, user.id))).returning();
	if (deleted.length === 0) return problemJson(c, 404, "Note not found.");
	return c.body(null, 204);
});

// ============================================================
// Reading Progress (#8: better response, #9: idempotent delete, #10: enriched GET)
// ============================================================

const getReadingProgressRoute = createRoute({
	operationId: "getReadingProgress",
	method: "get",
	path: "/reading-progress",
	tags: ["Reading Progress"],
	summary: "Get reading progress summary per paper with refs and completion",
	responses: {
		200: {
			description: "Reading progress per paper",
			content: { "application/json": { schema: z.object({ data: z.array(ReadingProgressSummaryResponse) }) } },
		},
		401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponse } } },
	},
});

meRoute.openapi(getReadingProgressRoute, async (c) => {
	const user = getUser(c);
	const { db } = getDb(c.env?.HYPERDRIVE);

	// Get all read paragraph IDs for this user, joined with paragraphs for sortId
	const readRows = await db
		.select({
			paperId: readingProgress.paperId,
			paragraphId: readingProgress.paragraphId,
			sortId: paragraphs.sortId,
		})
		.from(readingProgress)
		.leftJoin(paragraphs, eq(readingProgress.paragraphId, paragraphs.id))
		.where(eq(readingProgress.userId, user.id))
		.orderBy(paragraphs.sortId);

	// Get total paragraph counts per paper (static content, could be cached)
	const paperCounts = await db
		.select({
			paperId: paragraphs.paperId,
			total: count(),
		})
		.from(paragraphs)
		.groupBy(paragraphs.paperId);

	const totalMap = new Map(paperCounts.map((r) => [r.paperId, r.total]));

	// Get paper titles
	const paperIds = [...new Set(readRows.map((r) => r.paperId))];
	const paperTitles = new Map<string, string>();
	if (paperIds.length > 0) {
		const titleRows = await db
			.select({ paperId: paragraphs.paperId, paperTitle: paragraphs.paperTitle })
			.from(paragraphs)
			.where(sql`${paragraphs.paperId} IN ${paperIds}`)
			.groupBy(paragraphs.paperId, paragraphs.paperTitle);
		for (const r of titleRows) paperTitles.set(r.paperId, r.paperTitle);
	}

	// Group read refs by paper
	const paperProgress = new Map<string, string[]>();
	for (const row of readRows) {
		if (!paperProgress.has(row.paperId)) paperProgress.set(row.paperId, []);
		paperProgress.get(row.paperId)!.push(row.paragraphId);
	}

	const data = Array.from(paperProgress.entries()).map(([paperId, readRefs]) => {
		const totalParagraphs = totalMap.get(paperId) ?? 0;
		return {
			paperId,
			paperTitle: paperTitles.get(paperId) ?? "",
			readCount: readRefs.length,
			totalParagraphs,
			percentage: totalParagraphs > 0 ? Math.round((readRefs.length / totalParagraphs) * 10000) / 100 : 0,
			readRefs,
		};
	});

	return c.json({ data }, 200);
});

const markReadRoute = createRoute({
	operationId: "markRead",
	method: "post",
	path: "/reading-progress",
	tags: ["Reading Progress"],
	summary: "Mark paragraphs as read (batch, idempotent)",
	description: "Pass an array of paragraph references in any format. Already-read paragraphs are silently skipped.",
	request: { body: { required: true, content: { "application/json": { schema: ReadingProgressBatch } } } },
	responses: {
		200: {
			description: "Result",
			content: {
				"application/json": {
					schema: z.object({
						data: z.object({ marked: z.number(), alreadyRead: z.number(), total: z.number() }),
					}),
				},
			},
		},
		401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponse } } },
	},
});

meRoute.openapi(markReadRoute, async (c) => {
	const user = getUser(c);
	const { refs } = c.req.valid("json");
	const { db } = getDb(c.env?.HYPERDRIVE);

	const resolved = await Promise.all(refs.map((ref) => resolveParagraphRef(db, ref)));
	const valid = resolved.filter((r): r is NonNullable<typeof r> => r !== null);
	if (valid.length === 0) return c.json({ data: { marked: 0, alreadyRead: 0, total: refs.length } }, 200);

	const values = valid.map((item) => ({
		userId: user.id,
		paragraphId: item.globalId,
		paperId: item.paperId,
		paperSectionId: item.paperSectionId,
		paperSectionParagraphId: item.paperSectionParagraphId,
	}));

	const result = await db
		.insert(readingProgress)
		.values(values)
		.onConflictDoNothing({ target: [readingProgress.userId, readingProgress.paragraphId, readingProgress.appId] })
		.returning();

	return c.json({
		data: {
			marked: result.length,
			alreadyRead: valid.length - result.length,
			total: refs.length,
		},
	}, 200);
});

const deleteReadingProgressRoute = createRoute({
	operationId: "deleteReadingProgress",
	method: "delete",
	path: "/reading-progress/{ref}",
	tags: ["Reading Progress"],
	summary: "Unmark a paragraph as read (idempotent)",
	description: "Returns 204 whether or not progress existed. Returns 404 only if the paragraph ref is invalid.",
	request: { params: z.object({ ref: z.string() }) },
	responses: {
		204: { description: "Reading progress deleted (or didn't exist)" },
		401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Paragraph not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

meRoute.openapi(deleteReadingProgressRoute, async (c) => {
	const user = getUser(c);
	const { ref } = c.req.valid("param");
	const { db } = getDb(c.env?.HYPERDRIVE);

	const resolved = await resolveParagraphRef(db, ref);
	if (!resolved) return problemJson(c, 404, `Paragraph "${ref}" not found.`);

	// Idempotent: delete if exists, no error if not
	await db
		.delete(readingProgress)
		.where(and(eq(readingProgress.userId, user.id), eq(readingProgress.paragraphId, resolved.globalId)));

	return c.body(null, 204);
});

// ============================================================
// Preferences
// ============================================================

const getPreferencesRoute = createRoute({
	operationId: "getPreferences",
	method: "get",
	path: "/preferences",
	tags: ["Preferences"],
	summary: "Get user preferences",
	responses: {
		200: { description: "User preferences", content: { "application/json": { schema: z.object({ data: z.record(z.string(), z.unknown()) }) } } },
		401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponse } } },
	},
});

meRoute.openapi(getPreferencesRoute, async (c) => {
	const user = getUser(c);
	const { db } = getDb(c.env?.HYPERDRIVE);
	const [row] = await db.select().from(userPreferences).where(eq(userPreferences.userId, user.id)).limit(1);
	return c.json({ data: (row?.preferences as Record<string, unknown>) ?? {} }, 200);
});

const updatePreferencesRoute = createRoute({
	operationId: "updatePreferences",
	method: "put",
	path: "/preferences",
	tags: ["Preferences"],
	summary: "Update user preferences (shallow merge)",
	request: { body: { required: true, content: { "application/json": { schema: PreferencesUpdate } } } },
	responses: {
		200: { description: "Updated preferences", content: { "application/json": { schema: z.object({ data: z.record(z.string(), z.unknown()) }) } } },
		401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponse } } },
	},
});

meRoute.openapi(updatePreferencesRoute, async (c) => {
	const user = getUser(c);
	const body = c.req.valid("json");
	const { db } = getDb(c.env?.HYPERDRIVE);

	const [existing] = await db.select().from(userPreferences).where(eq(userPreferences.userId, user.id)).limit(1);
	const merged = { ...((existing?.preferences as Record<string, unknown>) ?? {}), ...body };

	if (existing) {
		await db.update(userPreferences).set({ preferences: merged, updatedAt: new Date() }).where(eq(userPreferences.userId, user.id));
	} else {
		await db.insert(userPreferences).values({ userId: user.id, preferences: merged });
	}

	return c.json({ data: merged }, 200);
});

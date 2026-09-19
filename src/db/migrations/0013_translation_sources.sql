CREATE TABLE "languages" (
	"code" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"bcp47" text NOT NULL,
	"ui_label" text NOT NULL,
	"ui_label_english" text NOT NULL,
	"sort_id" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "languages_slug_idx" ON "languages" USING btree ("slug");
--> statement-breakpoint
CREATE TABLE "translation_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"language_code" text NOT NULL,
	"tree_slug" text NOT NULL,
	"version_number" text,
	"pipeline_version" integer,
	"region_code" text,
	"first_published" integer,
	"copyright_year" integer,
	"edition_native" text,
	"edition_english" text,
	"book_title" text,
	"source_file" text,
	"source_url" text,
	"source_sha256" text,
	"source_layout" text,
	"is_primary" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "translation_sources" ADD CONSTRAINT "translation_sources_language_code_languages_code_fk" FOREIGN KEY ("language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "translation_sources_language_idx" ON "translation_sources" USING btree ("language_code");
--> statement-breakpoint
CREATE INDEX "translation_sources_tree_slug_idx" ON "translation_sources" USING btree ("tree_slug");
--> statement-breakpoint
INSERT INTO "languages" ("code", "slug", "bcp47", "ui_label", "ui_label_english", "sort_id")
VALUES ('eng', 'eng', 'en', 'English', 'English', '0-eng')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
INSERT INTO "languages" ("code", "slug", "bcp47", "ui_label", "ui_label_english", "sort_id")
SELECT DISTINCT
	"language",
	"language",
	CASE WHEN "language" = 'eng' THEN 'en' ELSE "language" END,
	"language",
	"language",
	CASE WHEN "language" = 'eng' THEN '0-eng' ELSE ('1-' || "language") END
FROM "paragraph_translations"
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
INSERT INTO "languages" ("code", "slug", "bcp47", "ui_label", "ui_label_english", "sort_id")
SELECT DISTINCT
	"language",
	"language",
	CASE WHEN "language" = 'eng' THEN 'en' ELSE "language" END,
	"language",
	"language",
	CASE WHEN "language" = 'eng' THEN '0-eng' ELSE ('1-' || "language") END
FROM "title_translations"
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
INSERT INTO "translation_sources" ("id", "language_code", "tree_slug", "edition_english", "is_primary")
SELECT DISTINCT
	CASE
		WHEN "source" LIKE 'UF-%' THEN "source"
		ELSE "language" || ':' || "source" || ':v' || "version"::text
	END,
	"language",
	"language",
	"source",
	false
FROM "paragraph_translations"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "translation_sources" ("id", "language_code", "tree_slug", "edition_english", "is_primary")
SELECT DISTINCT
	CASE
		WHEN "source" LIKE 'UF-%' THEN "source"
		ELSE "language" || ':' || "source" || ':v' || "version"::text
	END,
	"language",
	"language",
	"source",
	false
FROM "title_translations"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
UPDATE "translation_sources" AS t
SET "is_primary" = true
FROM (
	SELECT DISTINCT ON ("language_code") "id"
	FROM "translation_sources"
	ORDER BY "language_code", "id"
) AS first
WHERE t."id" = first."id";
--> statement-breakpoint
ALTER TABLE "paragraph_translations" ADD COLUMN "source_id" text;
--> statement-breakpoint
UPDATE "paragraph_translations"
SET "source_id" = CASE
	WHEN "source" LIKE 'UF-%' THEN "source"
	ELSE "language" || ':' || "source" || ':v' || "version"::text
END
WHERE "source_id" IS NULL;
--> statement-breakpoint
DELETE FROM "paragraph_translations" AS a
USING "paragraph_translations" AS b
WHERE a."paragraph_id" = b."paragraph_id"
	AND a."source_id" = b."source_id"
	AND (
		a."version" < b."version"
		OR (a."version" = b."version" AND a.ctid < b.ctid)
	);
--> statement-breakpoint
UPDATE "paragraph_translations"
SET "id" = "paragraph_id" || ':' || "source_id";
--> statement-breakpoint
ALTER TABLE "paragraph_translations" ALTER COLUMN "source_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "paragraph_translations" ADD CONSTRAINT "paragraph_translations_source_id_translation_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."translation_sources"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "paragraph_translations" ADD CONSTRAINT "paragraph_translations_language_languages_code_fk" FOREIGN KEY ("language") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "title_translations" ADD COLUMN "translation_source_id" text;
--> statement-breakpoint
UPDATE "title_translations"
SET "translation_source_id" = CASE
	WHEN "source" LIKE 'UF-%' THEN "source"
	ELSE "language" || ':' || "source" || ':v' || "version"::text
END
WHERE "translation_source_id" IS NULL;
--> statement-breakpoint
DELETE FROM "title_translations" AS a
USING "title_translations" AS b
WHERE a."source_type" = b."source_type"
	AND a."source_id" = b."source_id"
	AND a."translation_source_id" = b."translation_source_id"
	AND (
		a."version" < b."version"
		OR (a."version" = b."version" AND a.ctid < b.ctid)
	);
--> statement-breakpoint
UPDATE "title_translations"
SET "id" = "source_type" || ':' || "source_id" || ':' || "translation_source_id";
--> statement-breakpoint
ALTER TABLE "title_translations" ALTER COLUMN "translation_source_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "title_translations" ADD CONSTRAINT "title_translations_translation_source_id_translation_sources_id_fk" FOREIGN KEY ("translation_source_id") REFERENCES "public"."translation_sources"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "title_translations" ADD CONSTRAINT "title_translations_language_languages_code_fk" FOREIGN KEY ("language") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP INDEX IF EXISTS "pt_paragraph_lang_version_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "pt_paragraph_source_idx" ON "paragraph_translations" USING btree ("paragraph_id","source_id");
--> statement-breakpoint
CREATE INDEX "pt_source_id_idx" ON "paragraph_translations" USING btree ("source_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "tt_type_source_lang_version_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "tt_type_source_edition_idx" ON "title_translations" USING btree ("source_type","source_id","translation_source_id");
--> statement-breakpoint
CREATE INDEX "tt_translation_source_idx" ON "title_translations" USING btree ("translation_source_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "translation_sources_one_primary_idx" ON "translation_sources" ("language_code") WHERE "is_primary" = true;

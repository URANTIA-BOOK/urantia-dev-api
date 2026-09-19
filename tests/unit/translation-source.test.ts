import { describe, expect, test } from "bun:test";
import {
	apiCodeToBcp47,
	languageSortId,
	languageUiLabels,
	overlaySourceId,
	pipelineCodeToApiCode,
	treeSlugFromPath,
} from "../../scripts/translation-source.ts";

describe("translation-source mapping", () => {
	test("pipeline slugs become API codes", () => {
		expect(pipelineCodeToApiCode("spa")).toBe("es");
		expect(pipelineCodeToApiCode("fre")).toBe("fr");
		expect(pipelineCodeToApiCode("ger")).toBe("de");
		expect(pipelineCodeToApiCode("eng")).toBe("eng");
		expect(pipelineCodeToApiCode("nld")).toBe("nl");
		expect(pipelineCodeToApiCode("cze")).toBe("cs");
		expect(pipelineCodeToApiCode("cz")).toBe("cs");
	});

	test("html lang uses bcp47", () => {
		expect(apiCodeToBcp47("eng", "eng")).toBe("en");
		expect(apiCodeToBcp47("es", "spa")).toBe("es");
	});

	test("UI labels come from Intl, not a hardcoded map", () => {
		const es = languageUiLabels("es", "spa", "es");
		expect(es.uiLabel).toBe("Español");
		expect(es.uiLabelEnglish).toBe("Spanish");
	});

	test("tree slug is the repo directory", () => {
		expect(treeSlugFromPath("/book/langs/spanish")).toBe("spanish");
		expect(treeSlugFromPath("/book/eng")).toBe("eng");
	});

	test("English sorts first; overlay ids keep UF stamps", () => {
		expect(languageSortId("eng")).toBe("0-eng");
		expect(languageSortId("es")).toBe("1-es");
		expect(overlaySourceId("es", "UF-SPA-419-1993-1.9")).toBe(
			"UF-SPA-419-1993-1.9",
		);
		expect(overlaySourceId("es", "urantia.dev", 2)).toBe("es:urantia.dev:v2");
	});
});

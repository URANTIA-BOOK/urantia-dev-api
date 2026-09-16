import { describe, expect, it } from "bun:test";
import { mergePartOverlays } from "../../src/lib/translations.ts";

describe("mergePartOverlays", () => {
	const english = [
		{
			id: "0",
			title: "Foreword",
			sponsorship: null,
		},
		{
			id: "1",
			title: "The Central and Superuniverses",
			sponsorship: "Sponsored by a Uversa Corps of Superuniverse Personalities.",
		},
	];

	it("returns English rows when no overlay exists", () => {
		expect(mergePartOverlays(english, [])).toEqual(english);
	});

	it("replaces titles and sponsorship from language-tree rows", () => {
		const next = mergePartOverlays(english, [
			{ sourceType: "part", sourceId: "0", title: "Prólogo" },
			{
				sourceType: "part",
				sourceId: "1",
				title: "El Universo Central y los Superuniversos",
			},
			{
				sourceType: "partSponsorship",
				sourceId: "1",
				title:
					"Auspiciada por un Cuerpo de Personalidades Superuniversales de Uversa.",
			},
		]);
		expect(next[0]).toEqual({ id: "0", title: "Prólogo", sponsorship: null });
		expect(next[1]?.title).toBe("El Universo Central y los Superuniversos");
		expect(next[1]?.sponsorship).toMatch(/Auspiciada/);
	});
});

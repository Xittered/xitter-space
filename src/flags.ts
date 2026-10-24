// Flags people can pick at sign-up; they show next to the name, in the place X
// puts an affiliate's organisation badge, served as /public/flag-<id>.svg.
// Pride flags are drawn here, square so they read at badge size. Country flags
// are Twemoji's (CC-BY 4.0, by Twitter), the client's own emoji images,
// saved in public/flags.

import { join } from "node:path";

type Flag = { name: string; stripes?: string[]; extra?: string; country?: string };

const PRIDE: Record<string, Flag> = {
	pride: { name: "Pride", stripes: ["#E40303", "#FF8C00", "#FFED00", "#008026", "#004CFF", "#732982"] },
	progress: {
		name: "Progress Pride",
		stripes: ["#E40303", "#FF8C00", "#FFED00", "#008026", "#004CFF", "#732982"],
		// chevrons on the hoist, outermost first: black, brown, light blue, pink, white
		extra: ["#000000", "#784F17", "#5BCEFA", "#F5A9B8", "#FFFFFF"]
			.map((c, i) => {
				const tip = 14 - i * 3;
				return `<path d="M0 0H${tip - 10}L${tip} 12L${tip - 10} 24H0Z" fill="${c}"/>`;
			})
			.join(""),
	},
	trans: { name: "Transgender", stripes: ["#5BCEFA", "#F5A9B8", "#FFFFFF", "#F5A9B8", "#5BCEFA"] },
	bi: { name: "Bisexual", stripes: ["#D60270", "#D60270", "#9B4F96", "#0038A8", "#0038A8"] },
	pan: { name: "Pansexual", stripes: ["#FF218C", "#FFD800", "#21B1FF"] },
	lesbian: { name: "Lesbian", stripes: ["#D52D00", "#EF7627", "#FF9A56", "#FFFFFF", "#D162A4", "#B55690", "#A30262"] },
	gay: { name: "Gay", stripes: ["#078D70", "#26CEAA", "#98E8C1", "#FFFFFF", "#7BADE2", "#5049CC", "#3D1A78"] },
	nonbinary: { name: "Non-binary", stripes: ["#FCF434", "#FFFFFF", "#9C59D1", "#2C2C2C"] },
	genderfluid: { name: "Genderfluid", stripes: ["#FF76A4", "#FFFFFF", "#C011D7", "#000000", "#2F3CBE"] },
	agender: { name: "Agender", stripes: ["#000000", "#BCC4C7", "#FFFFFF", "#B7F684", "#FFFFFF", "#BCC4C7", "#000000"] },
	asexual: { name: "Asexual", stripes: ["#000000", "#A3A3A3", "#FFFFFF", "#800080"] },
	aromantic: { name: "Aromantic", stripes: ["#3DA542", "#A7D379", "#FFFFFF", "#A9A9A9", "#000000"] },
	intersex: { name: "Intersex", stripes: ["#FFD800"], extra: `<circle cx="12" cy="12" r="5.5" fill="none" stroke="#7902AA" stroke-width="2"/>` },
};

// every ISO 3166-1 country and territory with a flag emoji, and the EU, UN and Kosovo
const COUNTRY_CODES =
	"AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET EU FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM UN US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW";
const regionName = new Intl.DisplayNames(["en"], { type: "region" });
// "country-" keeps them apart from the pride flags (Burundi is "bi", like Bisexual)
const COUNTRIES: Record<string, Flag> = Object.fromEntries(
	COUNTRY_CODES.split(" ")
		.map((code) => [`country-${code.toLowerCase()}`, { name: regionName.of(code) ?? code, country: code }] as const)
		.sort((a, b) => a[1].name.localeCompare(b[1].name, "en")),
);

export const FLAGS: Record<string, Flag> = { ...PRIDE, ...COUNTRIES };

export const isFlag = (id: unknown): id is string => typeof id === "string" && Object.hasOwn(FLAGS, id);

export const MAX_FLAGS = 4;
export const flagList = (v: unknown): string[] => (typeof v === "string" ? [...new Set(v.split(",").map((f) => f.trim()))].filter(isFlag).slice(0, MAX_FLAGS) : []);
export const flagValue = (v: unknown): string | null => flagList(v).join(",") || null;
export const unknownFlag = (v: unknown) => typeof v === "string" && v.split(",").some((f) => f.trim() && !isFlag(f.trim()));

// a country's emoji image, kept in public/flags/<code>.svg
const FLAG_DIR = join(import.meta.dir, "..", "public", "flags");
const countrySvg = async (code: string): Promise<string | undefined> => {
	const file = Bun.file(join(FLAG_DIR, `${code.toLowerCase()}.svg`));
	return (await file.exists()) ? file.text() : undefined;
};

export async function flagSvg(id: string): Promise<string | undefined> {
	const f = FLAGS[id];
	if (!f) return undefined;
	if (f.country) return countrySvg(f.country);
	const stripes = f.stripes ?? [];
	const h = 24 / stripes.length;
	const rects = stripes.map((c, i) => `<rect y="${(i * h).toFixed(3)}" width="24" height="${(h + 0.05).toFixed(3)}" fill="${c}"/>`).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${rects}${f.extra ?? ""}</svg>`;
}

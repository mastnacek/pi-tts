import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { TtsConfig, VaderProfile } from "./types.js";

export const AUDIO_DOCS: Record<string, string> = {
	"--global": "uložit následující nastavení globálně (~/.pi/agent/)",
	on: "zapne automatické předčítání odpovědí asistenta (TTS)",
	off: "vypne předčítání odpovědí (TTS)",
	stop: "okamžitě zastaví probíhající přehrávání",
	status: "zobrazí aktuální stav TTS, hlas a případné chyby",
	voice: "nastaví hlas pro syntézu řeči",
	backend: "výběr enginu: edge (cloud) nebo native (offline)",
	vader:
		"Darth Vader / DSP efekt (on | off | classic | vader2 | vader3 | c3po | depth <půltóny>)",
	vader2:
		"rychlé zapnutí Vader2 (temná sub-oktáva + robotický tremolo flanger)",
	vader3: "rychlé zapnutí Vader3 (vader2 profil)",
	c3po:
		"rychlé zapnutí C-3PO droid efektu (Haas delay + pásmový filtr + flanger)",
	prosody: "přirozená modulace intonace a tempa u Edge hlasů (on/off)",
	rate: "rychlost řeči (např. +10%, -15%)",
	say: "okamžitě přečte zadaný text",
	help: "zobrazí podrobnou nápovědu",
};

const NON_TERMINAL = new Set([
	"--global",
	"backend",
	"vader",
	"vader2",
	"vader3",
	"c3po",
	"prosody",
	"rate",
	"voice",
	"say",
]);

/** Tokens whose parameter list is enumerable and expands without a trailing space. */
const LAZY_EXPAND = new Set([
	"backend",
	"vader",
	"vader2",
	"vader3",
	"c3po",
	"prosody",
	"rate",
	"voice",
]);

type Pair = readonly [string, string];

const VOICES: readonly Pair[] = [
	["cs-CZ-AntoninNeural", "český mužský Antonín (Edge Cloud)"],
	["cs-CZ-VlastaNeural", "český ženský Vlasta (Edge Cloud)"],
	["Microsoft Jakub", "český mužský Jakub (Windows offline OneCore)"],
	["cs-CZ", "český systémový výchozí (offline)"],
	["cs", "český offline hlas (Linux espeak-ng)"],
	["sk-SK-LukasNeural", "slovenský mužský Lukáš (Edge Cloud)"],
	["sk-SK-ViktoriaNeural", "slovenský ženský Viktória (Edge Cloud)"],
	["Microsoft Laura", "slovenský ženský Laura (Windows offline OneCore)"],
	["sk-SK", "slovenský systémový výchozí (offline)"],
	["sk", "slovenský offline hlas (Linux espeak-ng)"],
	["en-US-GuyNeural", "anglický mužský Guy (Edge Cloud)"],
	["en-US-JennyNeural", "anglický ženský Jenny (Edge Cloud)"],
	["en-US-AvaNeural", "anglický ženský Ava (Edge Cloud)"],
	["en-US-EmmaNeural", "anglický ženský Emma (Edge Cloud)"],
	["Microsoft Zira", "anglický ženský Zira (Windows offline)"],
	["Microsoft David", "anglický mužský David (Windows offline)"],
];

const VADER_PROFILES: readonly (readonly [VaderProfile, string])[] = [
	["classic", "klasický Darth Vader profil (EQ + echo + flanger)"],
	["vader2", "Vader2 profil (temná sub-oktáva + robotický tremolo flanger)"],
	["vader3", "Vader3 profil (vader2 sub-oktáva + robotický flanger)"],
	["c3po", "C-3PO droid profil (Haas 10ms delay + 1.6kHz peak + flanger)"],
];

const RATE_VALUES: readonly Pair[] = [
	["rate +0%", "výchozí normální rychlost"],
	["rate +10%", "+10 % zrychlení"],
	["rate +20%", "+20 % zrychlení"],
	["rate -10%", "-10 % zpomalení"],
	["rate -20%", "-20 % zpomalení"],
];

const BACKEND_VALUES: readonly Pair[] = [
	["backend edge", "Microsoft Edge cloudové neurální hlasy"],
	["backend native", "offline systémové hlasy (Windows WinRT/SAPI5, Linux)"],
];

const VADER_DEPTH_VALUES: readonly Pair[] = [
	["vader depth auto", "automatická hloubka (0 na edge, -3 na native)"],
	["vader depth -1", "mírný posun (-1 půltón)"],
	["vader depth -2", "střední posun (-2 půltóny)"],
	["vader depth -3", "klasický Vader (-3 půltóny)"],
	["vader depth -4", "hluboký Vader (-4 půltóny)"],
];

/** Build the enumerable parameter rows for one second-level token. */
function parameterRows(head: string): readonly Pair[] | null {
	switch (head) {
		case "prosody":
			return [
				["prosody on", "zapnout konverzační modulaci intonace a tempa"],
				["prosody off", "vypnout modulaci (monotónní tempo)"],
			];
		case "backend":
			return BACKEND_VALUES;
		case "vader2":
		case "vader3":
		case "c3po":
			return [
				[`${head} on`, `zapnout ${head} efekt`],
				[`${head} off`, `vypnout ${head} efekt`],
			];
		case "vader":
			return [
				["vader on", "zapnout Vader efekt"],
				["vader off", "vypnout Vader efekt"],
				...VADER_PROFILES.map(
					([profile, description]): Pair => [`vader ${profile}`, description],
				),
				["vader depth ", "nastavit hloubku posunu půltónů"],
			];
		case "rate":
			return RATE_VALUES;
		case "voice":
			return VOICES.map(([name, description]): Pair => [`voice ${name}`, description]);
		default:
			return null;
	}
}

function toRows(pairs: readonly Pair[], prefix: string): AutocompleteItem[] {
	return pairs
		.map(([token, description]) => ({ value: token, label: token, description }))
		.filter((item) => item.value.toLowerCase().startsWith(prefix));
}

/** Voice rows carry the live `✓` marker for the voice currently in effect. */
function voiceRows(config: TtsConfig, prefix: string): AutocompleteItem[] {
	const active = `voice ${config.voice}`.toLowerCase();
	return VOICES.map(([name, description]) => {
		const token = `voice ${name}`;
		const isActive = token.toLowerCase() === active;
		return {
			value: token,
			label: isActive ? `${token} ✓` : token,
			description: isActive ? `${description} · ● AKTIVNÍ` : description,
		};
	}).filter((item) => item.value.toLowerCase().startsWith(prefix));
}

function secondLevel(head: string, prefix: string, config: TtsConfig): AutocompleteItem[] | null {
	if (head === "vader" && prefix.startsWith("vader depth ")) {
		const items = toRows(VADER_DEPTH_VALUES, prefix);
		return items.length > 0 ? items : null;
	}

	const pairs = parameterRows(head);
	if (pairs === null) return null;
	const items = head === "voice" ? voiceRows(config, prefix) : toRows(pairs, prefix);
	return items.length > 0 ? items : null;
}

function firstLevel(typed: string): AutocompleteItem[] | null {
	const items: AutocompleteItem[] = [];
	for (const [key, description] of Object.entries(AUDIO_DOCS)) {
		if (!key.toLowerCase().startsWith(typed)) continue;
		items.push({
			value: NON_TERMINAL.has(key) ? `${key} ` : key,
			label: key,
			description,
		});
	}
	return items.length > 0 ? items : null;
}

/** Build the `getArgumentCompletions` function for `/audio`. */
export function createAudioCompletions(getConfig: () => TtsConfig) {
	return (prefix: string): AutocompleteItem[] | null => {
		const trimmed = prefix.trimStart();

		const clean = (cleanPrefix: string): AutocompleteItem[] | null => {
			const tokens = cleanPrefix.split(/\s+/).filter(Boolean);
			const head = (tokens[0] ?? "").toLowerCase();
			const trailingSpace = /\s$/.test(cleanPrefix);
			const deeper =
				tokens.length > 1 ||
				(trailingSpace && tokens.length === 1) ||
				(tokens.length === 1 && LAZY_EXPAND.has(head));

			if (!deeper) return firstLevel(head);
			return secondLevel(head, cleanPrefix.toLowerCase(), getConfig());
		};

		if (!trimmed.startsWith("--global")) return clean(trimmed);

		const afterGlobal = trimmed.slice(8).trimStart();
		const hasTrailingSpace = trimmed.length > 8 || /\s$/.test(prefix);
		if (!hasTrailingSpace && afterGlobal === "") {
			return [
				{
					value: "--global ",
					label: "--global",
					description: AUDIO_DOCS["--global"] ?? "uložit trvale",
				},
			];
		}

		const subCompletions = clean(afterGlobal);
		if (!subCompletions) return null;

		return subCompletions
			.filter((item) => item.label !== "--global")
			.map((item) => ({
				value: `--global ${item.value}`,
				label: item.label,
				description: item.description,
			}));
	};
}

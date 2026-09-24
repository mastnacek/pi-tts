import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AUDIO_DOCS, createAudioCompletions } from "./completions.js";
import { handleProfileShortcut, handleVader } from "./command-vader.js";
import type { TtsConfig } from "./types.js";

/**
 * The full surface the /audio command needs. `command-vader` consumes a
 * structurally-compatible subset, so the same object satisfies both.
 */
export interface AudioCommandDeps {
	getConfig: () => TtsConfig;
	patchConfig: (patch: Partial<TtsConfig>, isGlobal: boolean, cwd?: string) => void;
	refreshStatus: (ctx: ExtensionCommandContext) => void;
	speak: (text: string) => Promise<void>;
	stopSpeaking: () => void;
	getLastError: () => string;
	getLastSpokenAt: () => number;
	getPlatformLabel: () => string;
}

/** One parsed `/audio` invocation, handed to whichever subcommand matched. */
interface AudioInvocation {
	deps: AudioCommandDeps;
	ctx: ExtensionCommandContext;
	value: string;
	isGlobal: boolean;
	suffix: string;
}

type AudioHandler = (inv: AudioInvocation) => void | Promise<void>;

const OFF_VALUES = new Set(["off", "false", "0"]);
const ON_VALUES = new Set(["on", "true", "1"]);

function helpText(config: TtsConfig, lastError: string): string {
	return [
		`pi-tts — stav: ${config.enabled ? "ZAPNUTO (ON)" : "VYPNUTO (OFF)"}`,
		"Předčítání finálních odpovědí asistenta pomocí hlasové syntézy.",
		"",
		"Příkazy:",
		"/audio                  — tato nápověda + stav",
		"/audio on|off           — zapne / vypne TTS",
		"/audio stop             — okamžitě zastaví probíhající přehrávání",
		"/audio status           — zobrazí podrobný stav a diagnostiku",
		"/audio voice <název>    — nastavení hlasu (např. cs-CZ-AntoninNeural)",
		"/audio backend edge|native — cloudový Edge nebo offline systémový engine",
		"/audio vader on|off|depth <půltóny> — Darth Vader efekt",
		"/audio rate ±N%         — rychlost řeči (např. +10%, -15%)",
		"/audio say <text>       — okamžitě přečte zadaný text",
		"",
		"Přidejte `--global` pro uložení do ~/.pi/agent/pi-tts.json (bez něj se ukládá do .pi/ projektu).",
		"",
		`Nastavení: backend=${config.backend} | hlas=${config.voice} | rychlost=${config.rate} | vader=${config.vader ? "ON" : "OFF"}${config.vaderDepth === null ? "" : ` (${config.vaderDepth})`}`,
		lastError ? `Poslední chyba: ${lastError}` : "Bez chyb.",
	].join("\n");
}

function statusText(deps: AudioCommandDeps): string {
	const config = deps.getConfig();
	const lastSpokenAt = deps.getLastSpokenAt();
	const lastError = deps.getLastError();
	const vaderTag = config.vader ? (config.vaderProfile ?? "classic") : "off";
	return (
		`TTS ${config.enabled ? "ON" : "OFF"} | backend=${config.backend} voice=${config.voice} ` +
		`rate=${config.rate} vader=${vaderTag} depth=${config.vaderDepth ?? "auto"}` +
		(lastSpokenAt ? ` | naposledy mluvil ${new Date(lastSpokenAt).toLocaleTimeString()}` : "") +
		(lastError ? ` | poslední chyba: ${lastError}` : "")
	);
}

// ------------------------------------------------------------------ handlers

const handleOn: AudioHandler = ({ deps, ctx, isGlobal, suffix }) => {
	deps.patchConfig({ enabled: true }, isGlobal, ctx.cwd);
	deps.refreshStatus(ctx);
	ctx.ui.notify(`Audio TTS: ZAPNUTO (ON)${suffix}`, "info");
};

const handleOff: AudioHandler = ({ deps, ctx, isGlobal, suffix }) => {
	deps.patchConfig({ enabled: false }, isGlobal, ctx.cwd);
	deps.stopSpeaking();
	deps.refreshStatus(ctx);
	ctx.ui.notify(`Audio TTS: VYPNUTO (OFF)${suffix}`, "info");
};

const handleStop: AudioHandler = ({ deps, ctx }) => {
	deps.stopSpeaking();
	ctx.ui.notify("Přehrávání zastaveno", "info");
};

const handleStatus: AudioHandler = ({ deps, ctx }) => {
	ctx.ui.notify(statusText(deps), "info");
};

const handleVoice: AudioHandler = ({ deps, ctx, value, isGlobal, suffix }) => {
	if (!value) {
		ctx.ui.notify(`Aktuální hlas: ${deps.getConfig().voice}`, "info");
		return;
	}
	deps.patchConfig({ voice: value }, isGlobal, ctx.cwd);
	deps.refreshStatus(ctx);
	ctx.ui.notify(`Hlas nastaven na: ${value}${suffix}`, "info");
};

/** `/audio prosody [on|off]` — bare invocation toggles. */
const handleProsody: AudioHandler = ({ deps, ctx, value, isGlobal }) => {
	const lower = value.toLowerCase();
	if (ON_VALUES.has(lower)) {
		deps.patchConfig({ prosody: true }, isGlobal, ctx.cwd);
		ctx.ui.notify("Konverzační prosodie: ZAPNUTO (ON)", "info");
		return;
	}
	if (OFF_VALUES.has(lower)) {
		deps.patchConfig({ prosody: false }, isGlobal, ctx.cwd);
		ctx.ui.notify("Konverzační prosodie: VYPNUTO (OFF)", "info");
		return;
	}
	const next = !deps.getConfig().prosody;
	deps.patchConfig({ prosody: next }, isGlobal, ctx.cwd);
	ctx.ui.notify(`Konverzační prosodie: ${next ? "ZAPNUTO (ON)" : "VYPNUTO (OFF)"}`, "info");
};

const handleBackend: AudioHandler = ({ deps, ctx, value, isGlobal }) => {
	const lower = value.toLowerCase();
	if (lower !== "edge" && lower !== "native") {
		ctx.ui.notify("Použití: /audio backend edge|native", "warning");
		return;
	}
	deps.patchConfig({ backend: lower }, isGlobal, ctx.cwd);
	deps.refreshStatus(ctx);
	ctx.ui.notify(
		lower === "edge"
			? "Backend nastaven na Edge (cloudové neurální hlasy)"
			: `Backend nastaven na native (offline ${deps.getPlatformLabel()} hlasy)`,
		"info",
	);
};

const handleRate: AudioHandler = ({ deps, ctx, value, isGlobal }) => {
	if (!/^[+-]\d+%$/.test(value)) {
		ctx.ui.notify("Použití: /audio rate +10% (nebo -10%)", "warning");
		return;
	}
	deps.patchConfig({ rate: value }, isGlobal, ctx.cwd);
	ctx.ui.notify(`Rychlost řeči nastavena na ${value}`, "info");
};

const handleSay: AudioHandler = async ({ deps, ctx, value }) => {
	if (!value) {
		ctx.ui.notify("Použití: /audio say <text>", "warning");
		return;
	}
	await deps.speak(value);
	ctx.ui.notify("Přehrávám text…", "info");
};

const handleHelp: AudioHandler = ({ deps, ctx }) => {
	ctx.ui.notify(helpText(deps.getConfig(), deps.getLastError()), "info");
};

/** `/audio c3po|vader2|vader3 [on|off]` and `/audio vader ...` delegate to the DSP module. */
const profileShortcut =
	(command: string): AudioHandler =>
	({ deps, ctx, value, isGlobal }) => {
		handleProfileShortcut(deps, ctx, command, value, isGlobal);
	};

const handleVaderCommand: AudioHandler = ({ deps, ctx, value, isGlobal }) => {
	handleVader(deps, ctx, value, isGlobal);
};

const SUBCOMMANDS: Record<string, AudioHandler> = {
	on: handleOn,
	off: handleOff,
	stop: handleStop,
	status: handleStatus,
	voice: handleVoice,
	prosody: handleProsody,
	backend: handleBackend,
	rate: handleRate,
	say: handleSay,
	help: handleHelp,
	c3po: profileShortcut("c3po"),
	vader2: profileShortcut("vader2"),
	vader3: profileShortcut("vader3"),
	vader: handleVaderCommand,
};

export function registerAudioCommand(pi: ExtensionAPI, deps: AudioCommandDeps): void {
	pi.registerCommand("audio", {
		description:
			"pi-tts: předčítání odpovědí asistenta (TTS) přes Edge cloud nebo offline hlasy, Darth Vader režim",
		getArgumentCompletions: createAudioCompletions(deps.getConfig),

		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const isGlobal = tokens.some((t) => t.toLowerCase() === "--global");
			const cleanTokens = tokens.filter((t) => t.toLowerCase() !== "--global");
			const sub = (cleanTokens[0] ?? "help").toLowerCase();
			const inv: AudioInvocation = {
				deps,
				ctx,
				value: cleanTokens.slice(1).join(" ").trim(),
				isGlobal,
				suffix: isGlobal ? " (globálně)" : " (do projektu)",
			};

			const handler = SUBCOMMANDS[sub];
			if (handler === undefined) {
				if (sub in AUDIO_DOCS) {
					ctx.ui.notify(`Příkaz „${sub}“ zatím nemá obsluhu. Použij: /audio help`, "warning");
					return;
				}
				ctx.ui.notify(`Neznámý příkaz „${sub}“. Použij: /audio help`, "warning");
				return;
			}
			await handler(inv);
		},
	});
}

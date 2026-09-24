import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TtsConfig, VaderProfile } from "./types.js";

/** Everything the /audio handlers need from the composition root. */
export interface AudioCommandDeps {
	getConfig: () => TtsConfig;
	patchConfig: (patch: Partial<TtsConfig>, isGlobal: boolean, cwd?: string) => void;
	refreshStatus: (ctx: ExtensionCommandContext) => void;
}

/** One selectable DSP profile, with the confirmation message it prints. */
interface ProfileChoice {
	token: string;
	profile: VaderProfile;
	message: string;
}

const OFF_VALUES = new Set(["off", "false", "0"]);
const ON_VALUES = new Set(["on", "true", "1"]);

const PROFILE_CHOICES: readonly ProfileChoice[] = [
	{
		token: "c3po",
		profile: "c3po",
		message: "Vader profil: C-3PO (Haas delay + 1.6kHz peak + flanger)",
	},
	{
		token: "vader2",
		profile: "vader2",
		message: "Vader profil: VADER2 (temná sub-oktáva + robotický tremolo flanger)",
	},
	{ token: "vader3", profile: "vader3", message: "Vader profil: VADER3 [profil: vader2]" },
	{ token: "classic", profile: "classic", message: "Vader profil: CLASSIC (původní Darth Vader)" },
	{ token: "vader1", profile: "classic", message: "Vader profil: CLASSIC (původní Darth Vader)" },
	{ token: "default", profile: "classic", message: "Vader profil: CLASSIC (původní Darth Vader)" },
];

/** Profile shortcuts whose own subcommand (`/audio vader2 on|off`) needs a message. */
const SHORTCUT_MESSAGES: Record<string, string> = {
	c3po: "C-3PO droid režim: ZAPNUTO (ON) — Haas 10ms delay + 1.6kHz peak + flanger",
	vader2: "Vader2 režim: ZAPNUTO (ON) — temná sub-oktáva + robotický tremolo flanger",
	vader3: "Vader3 režim: ZAPNUTO (ON) [profil: vader2]",
};

function isOffValue(value: string): boolean {
	return OFF_VALUES.has(value.toLowerCase());
}

function isOnValue(value: string): boolean {
	return ON_VALUES.has(value.toLowerCase());
}

/** Turn the DSP effect off (shared by every Vader/C-3PO subcommand). */
function disableEffect(deps: AudioCommandDeps, ctx: ExtensionCommandContext, isGlobal: boolean): void {
	deps.patchConfig({ vader: false }, isGlobal, ctx.cwd);
	deps.refreshStatus(ctx);
	ctx.ui.notify("Vader hlas: VYPNUTO (OFF)", "info");
}

/** Enable one profile and report it. */
function enableProfile(
	deps: AudioCommandDeps,
	ctx: ExtensionCommandContext,
	profile: VaderProfile,
	message: string,
	isGlobal: boolean,
): void {
	deps.patchConfig({ vader: true, vaderProfile: profile }, isGlobal, ctx.cwd);
	deps.refreshStatus(ctx);
	ctx.ui.notify(message, "info");
}

/** `/audio vader2|vader3|c3po [on|off]` — on is the default when no value is given. */
export function handleProfileShortcut(
	deps: AudioCommandDeps,
	ctx: ExtensionCommandContext,
	command: string,
	value: string,
	isGlobal: boolean,
): void {
	if (isOffValue(value)) {
		disableEffect(deps, ctx, isGlobal);
		return;
	}
	enableProfile(deps, ctx, command as VaderProfile, SHORTCUT_MESSAGES[command] ?? command, isGlobal);
}

function handleDepth(
	deps: AudioCommandDeps,
	ctx: ExtensionCommandContext,
	arg: string,
	isGlobal: boolean,
): void {
	if (arg === "auto" || arg === "") {
		deps.patchConfig({ vaderDepth: null }, isGlobal, ctx.cwd);
		ctx.ui.notify("Vader hloubka: auto (0 na edge, -3 na native)", "info");
		return;
	}
	if (Number.isFinite(Number(arg))) {
		const depth = Number(arg);
		deps.patchConfig({ vaderDepth: depth }, isGlobal, ctx.cwd);
		ctx.ui.notify(`Vader hloubka: ${depth} půltónů (záporná = hlubší)`, "info");
		return;
	}
	const current = deps.getConfig().vaderDepth ?? "auto";
	ctx.ui.notify(
		`Vader hloubka je ${current}. Použití: /audio vader depth -3 (nebo auto)`,
		"warning",
	);
}

/** `/audio vader [on|off|classic|vader2|vader3|c3po|depth <semitones>]`. */
export function handleVader(
	deps: AudioCommandDeps,
	ctx: ExtensionCommandContext,
	value: string,
	isGlobal: boolean,
): void {
	const tokens = value.split(/\s+/).filter(Boolean);
	const mode = (tokens[0] ?? "").toLowerCase();
	const arg = (tokens[1] ?? "").toLowerCase();
	const config = deps.getConfig();

	if (isOnValue(mode)) {
		deps.patchConfig({ vader: true }, isGlobal, ctx.cwd);
		deps.refreshStatus(ctx);
		ctx.ui.notify(
			`Vader hlas: ZAPNUTO (ON) [profil: ${config.vaderProfile ?? "classic"}]`,
			"info",
		);
		return;
	}
	if (isOffValue(mode)) {
		disableEffect(deps, ctx, isGlobal);
		return;
	}
	if (mode === "depth") {
		handleDepth(deps, ctx, arg, isGlobal);
		return;
	}

	const choice = PROFILE_CHOICES.find((entry) => entry.token === mode);
	if (choice) {
		enableProfile(deps, ctx, choice.profile, choice.message, isGlobal);
		return;
	}

	if (mode) {
		ctx.ui.notify(
			`Vader hlas je ${config.vader ? "ZAPNUT" : "VYPNUT"} (profil: ${config.vaderProfile ?? "classic"}, hloubka: ${config.vaderDepth ?? "auto"}). Použití: /audio vader on|off|classic|vader2|depth <půltóny>`,
			"info",
		);
		return;
	}

	const next = !config.vader;
	deps.patchConfig({ vader: next }, isGlobal, ctx.cwd);
	deps.refreshStatus(ctx);
	ctx.ui.notify(
		`Vader hlas: ${next ? `ZAPNUTO (ON) [${config.vaderProfile ?? "classic"}]` : "VYPNUTO (OFF)"}`,
		"info",
	);
}

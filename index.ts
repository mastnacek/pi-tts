/**
 * pi-tts — composition root.
 *
 * Layout:
 *   index.ts            wiring: events, statusline, /audio registration
 *   src/config.ts       cascade load/save (defaults <- global <- project)
 *   src/speak.ts        spawn speak.py, cooperative stop, text extraction
 *   src/completions.ts  /audio menu incl. `--global` prefix support
 *   src/command.ts      /audio dispatch table
 *   src/command-vader.ts Vader / C-3PO DSP profiles
 *   src/types.ts        TtsConfig
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./src/config.js";
import { registerAudioCommand, type AudioCommandDeps } from "./src/command.js";
import {
	extractText,
	getLastError,
	getLastSpokenAt,
	getPlatformLabel,
	speak,
	stopSpeaking,
} from "./src/speak.js";
import type { TtsConfig } from "./src/types.js";

export type { TtsConfig } from "./src/types.js";

export default function (pi: ExtensionAPI) {
	/** Unsubscribers from every `pi.on()`; drained on session_shutdown (AGENTS §5). */
	const unsubscribers: Array<() => void> = [];

	/** Retain a `pi.on()` return value; older engine typings declare it void. */
	const track = (result: unknown): void => {
		if (typeof result === "function") unsubscribers.push(result as () => void);
	};

	/** Defaults + global at construction; the project layer joins on session_start. */
	let config: TtsConfig = loadConfig();
	let currentCwd: string | undefined;

	const patchConfig = (
		patch: Partial<TtsConfig>,
		isGlobal: boolean,
		cwd?: string,
	): void => {
		config = { ...config, ...patch };
		saveConfig(config, isGlobal, cwd ?? currentCwd);
	};

	const refreshTtsStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (!config.enabled) {
			ctx.ui.setStatus("pi-tts", undefined);
			return;
		}
		let vTag = "vader";
		if (config.vaderProfile === "c3po") vTag = "c3po";
		else if (config.vaderProfile === "vader2") vTag = "vader2";
		else if (config.vaderProfile === "vader3") vTag = "vader3";
		ctx.ui.setStatus(
			"pi-tts",
			config.vader ? `🔊 ${config.voice} ${vTag}` : `🔊 ${config.voice}`,
		);
	};

	/** Speak the final assistant message once the agent fully settles. */
	track(pi.on("agent_settled", async (_event, ctx) => {
		if (!config.enabled) return;
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as { message?: unknown } | undefined;
			const message = entry?.message ?? entry;
			if ((message as { role?: string } | undefined)?.role !== "assistant") continue;
			const text = extractText(message);
			if (!text) continue;
			await speak(text, config);
			return;
		}
	}));

	// A new user prompt interrupts playback.
	track(pi.on("agent_start", () => {
		stopSpeaking();
	}));

	track(pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		currentCwd = ctx.cwd;
		config = loadConfig(ctx.cwd);
		refreshTtsStatus(ctx);
	}));

	pi.on("session_shutdown", () => {
		while (unsubscribers.length > 0) unsubscribers.pop()?.();
		stopSpeaking();
	});

	const deps: AudioCommandDeps = {
		getConfig: () => config,
		patchConfig,
		refreshStatus: refreshTtsStatus,
		speak: (text) => speak(text, config),
		stopSpeaking,
		getLastError,
		getLastSpokenAt,
		getPlatformLabel,
	};

	registerAudioCommand(pi, deps);
}

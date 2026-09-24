import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TtsConfig } from "./types.js";

export const DEFAULTS: TtsConfig = {
	enabled: false,
	backend: "edge",
	voice: process.env.PI_TTS_VOICE ?? "cs-CZ-AntoninNeural",
	rate: process.env.PI_TTS_RATE ?? "+0%",
	pitch: process.env.PI_TTS_PITCH ?? "+0Hz",
	vader: false,
	vaderProfile:
		(process.env.PI_TTS_VADER_PROFILE as
			| "classic"
			| "vader2"
			| "vader3"
			| "c3po") ?? "classic",
	vaderDepth: null,
	prosody: true,
	maxLen: 1500,
};

export const GLOBAL_CONFIG_FILE = join(homedir(), ".pi", "agent", "pi-tts.json");

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "pi-tts.json");
}

export function loadConfig(cwd?: string): TtsConfig {
	let merged: TtsConfig = { ...DEFAULTS };

	// 1. Global
	try {
		if (existsSync(GLOBAL_CONFIG_FILE)) {
			const parsed = JSON.parse(readFileSync(GLOBAL_CONFIG_FILE, "utf-8"));
			merged = {
				...merged,
				...parsed,
				vaderProfile: parsed.vaderProfile ?? merged.vaderProfile,
			};
		}
	} catch {
		// ignore
	}

	// 2. Project
	if (cwd) {
		try {
			const pFile = projectConfigPath(cwd);
			if (existsSync(pFile)) {
				const parsed = JSON.parse(readFileSync(pFile, "utf-8"));
				merged = {
					...merged,
					...parsed,
					vaderProfile: parsed.vaderProfile ?? merged.vaderProfile,
				};
			}
		} catch {
			// ignore
		}
	}

	return merged;
}

export function saveConfig(cfg: TtsConfig, isGlobal = false, cwd?: string): void {
	const targetPath = isGlobal || !cwd ? GLOBAL_CONFIG_FILE : projectConfigPath(cwd);
	try {
		mkdirSync(dirname(targetPath), { recursive: true });
		writeFileSync(targetPath, JSON.stringify(cfg, null, 2), "utf8");
	} catch {
		// non-fatal
	}
}

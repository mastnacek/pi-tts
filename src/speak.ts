import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TtsConfig } from "./types.js";

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEAK_PY = join(EXT_DIR, "speak.py");
let cachedPython: string | null = null;

export function getPython(): string {
	if (cachedPython !== null) return cachedPython;
	if (process.platform === "win32") {
		cachedPython = "python";
		return cachedPython;
	}
	const delimiter = ":";
	const dirs = (process.env.PATH ?? "").split(delimiter);
	for (const candidate of ["python3", "python"]) {
		if (dirs.some((d) => existsSync(join(d, candidate)))) {
			cachedPython = candidate;
			return cachedPython;
		}
	}
	cachedPython = "python3";
	return cachedPython;
}

const STOP_FILE = join(tmpdir(), `pi-tts-stop-${process.pid}`);

let current: ChildProcess | null = null;
let speakSeq = 0;
let lastError = "";
let lastSpokenAt = 0;

export function getLastError(): string {
	return lastError;
}

export function getLastSpokenAt(): number {
	return lastSpokenAt;
}

export function stopSpeaking(): void {
	try {
		writeFileSync(STOP_FILE, String(Date.now()));
	} catch {
		/* ignore */
	}
	if (current && current.exitCode === null) {
		if (process.platform === "win32") {
			if (current.pid !== undefined) {
				spawn("taskkill", ["/pid", String(current.pid), "/T", "/F"], {
					stdio: "ignore",
				});
			}
			current.kill();
		} else {
			try {
				if (current.pid !== undefined) process.kill(-current.pid, "SIGTERM");
			} catch {
				current.kill();
			}
		}
	}
	current = null;
}

export async function speak(text: string, config: TtsConfig): Promise<void> {
	if (!text.trim()) return;
	stopSpeaking();

	try {
		await unlink(STOP_FILE);
	} catch {
		/* ignore */
	}

	const seq = ++speakSeq;
	const tmpFile = join(tmpdir(), `pi-tts-${process.pid}-${seq}.txt`);
	await writeFile(tmpFile, text, "utf-8");

	const args = [
		SPEAK_PY,
		"--file",
		tmpFile,
		"--backend",
		config.backend,
		"--voice",
		config.voice,
		"--rate",
		config.rate,
		"--pitch",
		config.pitch,
		config.vader ? "--vader" : "--no-vader",
		"--vader-profile",
		config.vaderProfile ?? "classic",
		config.prosody === false ? "--no-prosody" : "--prosody",
	];
	if (config.vader && config.vaderDepth !== null) {
		args.push("--depth", String(config.vaderDepth));
	}

	const child = spawn(getPython(), args, {
		detached: process.platform !== "win32",
		stdio: ["ignore", "ignore", "pipe"],
		env: {
			...process.env,
			PI_TTS_MAXLEN: String(config.maxLen),
			PI_TTS_STOP_FILE: STOP_FILE,
		},
	});
	current = child;
	lastSpokenAt = Date.now();
	let stderr = "";
	child.stderr?.on("data", (d) => (stderr += d));
	child.on("close", (code, signal) => {
		if (current === child) current = null;
		unlink(tmpFile).catch(() => {});
		if (code !== 0 && signal === null && stderr.trim()) {
			lastError = stderr.trim();
		}
	});
	child.on("error", (err) => {
		if (current === child) current = null;
		lastError = String(err);
	});
}

export function extractText(message: any): string {
	if (!message || message.role !== "assistant") return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content) {
		if (typeof block === "string") parts.push(block);
		else if (block?.type === "text" && typeof block.text === "string")
			parts.push(block.text);
	}
	return parts.join("\n");
}

export function getPlatformLabel(): string {
	if (process.platform === "win32") return "Windows";
	if (process.platform === "darwin") return "macOS";
	return "Linux";
}

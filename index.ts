import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface TtsConfig {
	enabled: boolean;
	backend: "edge" | "native";
	voice: string;
	rate: string;
	pitch: string;
	vader: boolean;
	/** Extra Vader pitch shift in semitones; null = per-backend default. */
	vaderDepth: number | null;
	maxLen: number;
}

const DEFAULTS: TtsConfig = {
	enabled: false,
	backend: "edge",
	voice: process.env.PI_TTS_VOICE ?? "cs-CZ-AntoninNeural",
	rate: process.env.PI_TTS_RATE ?? "+0%",
	pitch: process.env.PI_TTS_PITCH ?? "+0Hz",
	vader: false,
	vaderDepth: null,
	maxLen: 1500,
};

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const SPEAK_PY = join(EXT_DIR, "speak.py");
// Windows ships "python"; Linux distros often only have "python3".
function findPython(): string {
	if (process.platform === "win32") return "python";
	for (const candidate of ["python3", "python"]) {
		const dirs = (process.env.PATH ?? "").split(":");
		if (dirs.some((d) => existsSync(join(d, candidate)))) return candidate;
	}
	return "python3";
}
const PYTHON = findPython();
// Cooperative stop flag, scoped to this pi process (never stale across restarts).
const STOP_FILE = join(tmpdir(), `pi-tts-stop-${process.pid}`);
const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-tts.json");

function loadConfig(): TtsConfig {
	try {
		if (existsSync(CONFIG_PATH)) {
			return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
		}
	} catch {
		// corrupted config -> defaults
	}
	return { ...DEFAULTS };
}

function saveConfig(cfg: TtsConfig) {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
	} catch {
		// non-fatal
	}
}

/** Extract plain text from an assistant message. */
function extractText(message: any): string {
	if (!message || message.role !== "assistant") return "";
	const parts: string[] = [];
	for (const block of message.content ?? []) {
		if (typeof block === "string") parts.push(block);
		else if (block?.type === "text" && typeof block.text === "string")
			parts.push(block.text);
	}
	return parts.join("\n");
}

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	let current: ChildProcess | null = null;
	let speakSeq = 0;

	function stopSpeaking() {
		// Cooperative stop first: python is polling this file and kills its own
		// player (works even if the parent chain is already gone/stale).
		try {
			writeFileSync(STOP_FILE, String(Date.now()));
		} catch {}
		if (current && current.exitCode === null) {
			if (process.platform === "win32") {
				// current.kill() only terminates python.exe — the spawned
				// powershell/ffplay player is orphaned and keeps playing the file.
				// taskkill /T takes down the whole tree, /F because we mean it.
				if (current.pid !== undefined) {
					spawn(
						"taskkill",
						["/pid", String(current.pid), "/T", "/F"],
						{ stdio: "ignore" },
					);
				}
				current.kill();
			} else {
				// POSIX: python was spawned detached (process-group leader),
				// so a negative-pid kill takes ffplay down with it.
				try {
					if (current.pid !== undefined)
						process.kill(-current.pid, "SIGTERM");
				} catch {
					current.kill();
				}
			}
		}
		current = null;
	}

	async function speak(text: string) {
		if (!text.trim()) return;
		stopSpeaking();

		// Clear any stale stop flag so the new playback isn't instantly killed.
		// Missing file is the expected case — ignore unlink failures.
		try {
			await unlink(STOP_FILE);
		} catch {
			// noop
		}

		// Write text to temp file — avoids argv length/quoting issues
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
		];
		if (config.vader) {
			args.push("--vader");
			if (config.vaderDepth !== null)
				args.push("--depth", String(config.vaderDepth));
		}

	const child = spawn(PYTHON, args, {
		detached: process.platform !== "win32",
		stdio: ["ignore", "ignore", "pipe"],
		env: {
			...process.env,
			PI_TTS_MAXLEN: String(config.maxLen),
			PI_TTS_STOP_FILE: STOP_FILE,
		},
	});
		current = child;
		let stderr = "";
		child.stderr?.on("data", (d) => (stderr += d));
		child.on("close", (code, signal) => {
			if (current === child) current = null;
			unlink(tmpFile).catch(() => {});
			// speak.py also writes warnings (fallbacks it recovered from) to
			// stderr — only a non-zero exit means playback actually failed.
			if (code !== 0 && signal === null && stderr.trim()) {
				// surfaced lazily via /audio status
				lastError = stderr.trim();
			}
		});
		child.on("error", (err) => {
			if (current === child) current = null;
			lastError = String(err);
		});
	}

	let lastError = "";
	let lastSpokenAt = 0;

	// Speak the final assistant message once the agent fully settles
	pi.on("agent_settled", async (_event, ctx) => {
		if (!config.enabled) return;
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry: any = branch[i];
			const msg = entry?.message ?? entry;
			if (msg?.role === "assistant") {
				const text = extractText(msg);
				if (text) {
					lastSpokenAt = Date.now();
					lastError = "";
					await speak(text);
				}
				return;
			}
		}
	});

	// New user prompt interrupts playback
	pi.on("agent_start", async () => {
		stopSpeaking();
	});

	pi.on("session_shutdown", async () => {
		stopSpeaking();
	});

	pi.registerCommand("audio", {
		description:
			"TTS control: /audio on|off|stop|status|voice <name>|backend edge|native|vader on|off|vader depth <semitones>|rate <%>|say <text>",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const value = rest.join(" ");

			switch (sub) {
				case "on":
					config.enabled = true;
					saveConfig(config);
					ctx.ui.notify("Audio TTS: ON", "info");
					break;
				case "off":
					config.enabled = false;
					saveConfig(config);
					stopSpeaking();
					ctx.ui.notify("Audio TTS: OFF", "info");
					break;
				case "stop":
					stopSpeaking();
					ctx.ui.notify("Playback stopped", "info");
					break;
				case "status":
					ctx.ui.notify(
						`TTS ${config.enabled ? "ON" : "OFF"} | backend=${config.backend} voice=${config.voice} rate=${config.rate} vader=${config.vader ? "on" : "off"} depth=${config.vaderDepth ?? "auto"}` +
							(lastSpokenAt
								? ` | last spoken ${new Date(lastSpokenAt).toLocaleTimeString()}`
								: "") +
							(lastError ? ` | last error: ${lastError}` : ""),
						"info",
					);
					break;
				case "voice":
					if (!value) {
						ctx.ui.notify(`Current voice: ${config.voice}`, "info");
					} else {
						config.voice = value;
						saveConfig(config);
						ctx.ui.notify(`Voice set to ${value}`, "info");
					}
					break;
				case "backend":
					if (value === "edge" || value === "native") {
						config.backend = value;
						saveConfig(config);
						ctx.ui.notify(
value === "edge"
								? "Backend set to edge (cloud neural voices)"
								: `Backend set to native (offline ${process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"} voices)`,
							"info",
						);
					} else {
						ctx.ui.notify("Usage: /audio backend edge|native", "warning");
					}
					break;
				case "vader": {
					const [mode, arg] = value.split(/\s+/);
					if (mode === "on" || mode === "off") {
						config.vader = mode === "on";
						saveConfig(config);
						ctx.ui.notify(`Vader voice: ${mode.toUpperCase()}`, "info");
					} else if (mode === "depth") {
						if (arg === "auto") {
							config.vaderDepth = null;
							saveConfig(config);
							ctx.ui.notify(
								"Vader depth: auto (0 on edge, -3 on native)",
								"info",
							);
						} else if (arg !== undefined && Number.isFinite(Number(arg))) {
							config.vaderDepth = Number(arg);
							saveConfig(config);
							ctx.ui.notify(
								`Vader depth: ${config.vaderDepth} semitones (negative is deeper)`,
								"info",
							);
						} else {
							ctx.ui.notify(
								`Vader depth is ${config.vaderDepth ?? "auto"}. Usage: /audio vader depth -3 (or auto)`,
								"warning",
							);
						}
					} else {
						ctx.ui.notify(
							`Vader voice is ${config.vader ? "ON" : "OFF"}, depth ${config.vaderDepth ?? "auto"}. Usage: /audio vader on|off|depth <semitones>`,
							"info",
						);
					}
					break;
				}
				case "rate":
					if (/^[+-]\d+%$/.test(value)) {
						config.rate = value;
						saveConfig(config);
						ctx.ui.notify(`Rate set to ${value}`, "info");
					} else {
						ctx.ui.notify("Usage: /audio rate +10% (or -10%)", "warning");
					}
					break;
				case "say":
					if (value) {
						await speak(value);
						ctx.ui.notify("Speaking…", "info");
					} else {
						ctx.ui.notify("Usage: /audio say <text>", "warning");
					}
					break;
				default:
					ctx.ui.notify(
						"TTS is " +
							(config.enabled ? "ON" : "OFF") +
							". Commands: on, off, stop, status, voice <name>, backend edge|native, vader on|off, vader depth <semitones>, rate ±N%, say <text>",
						"info",
					);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		if (config.enabled && ctx.hasUI) {
			ctx.ui.setStatus(
				"pi-tts",
				config.vader ? `🔊 ${config.voice} 🪖 vader` : `🔊 ${config.voice}`,
			);
		}
	});
}

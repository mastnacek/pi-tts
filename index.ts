import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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

function getPlatformLabel(): string {
	if (process.platform === "win32") return "Windows";
	if (process.platform === "darwin") return "macOS";
	return "Linux";
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
		} catch {
			/* ignore write failure */
		}
		if (current && current.exitCode === null) {
			if (process.platform === "win32") {
				// current.kill() only terminates python.exe — the spawned
				// powershell/ffplay player is orphaned and keeps playing the file.
				// taskkill /T takes down the whole tree, /F because we mean it.
				if (current.pid !== undefined) {
					spawn("taskkill", ["/pid", String(current.pid), "/T", "/F"], {
						stdio: "ignore",
					});
				}
				current.kill();
			} else {
				// POSIX: python was spawned detached (process-group leader),
				// so a negative-pid kill takes ffplay down with it.
				try {
					if (current.pid !== undefined) process.kill(-current.pid, "SIGTERM");
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
			/* ignore unlink failure */
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
			config.vader ? "--vader" : "--no-vader",
		];
		if (config.vader && config.vaderDepth !== null) {
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
					return;
				}
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

	const refreshTtsStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (config.enabled) {
			ctx.ui.setStatus(
				"pi-tts",
				config.vader ? `🔊 ${config.voice} vader` : `🔊 ${config.voice}`,
			);
		} else {
			ctx.ui.setStatus("pi-tts", undefined);
		}
	};

	const AUDIO_DOCS: Record<string, string> = {
		on: "zapne automatické předčítání odpovědí asistenta (TTS)",
		off: "vypne předčítání odpovědí (TTS)",
		stop: "okamžitě zastaví probíhající přehrávání",
		status: "zobrazí aktuální stav TTS, hlas a případné chyby",
		voice: "nastaví hlas pro syntézu řeči",
		backend: "výběr enginu: edge (cloud) nebo native (offline)",
		vader: "Darth Vader efekt (on | off | depth <půltóny>)",
		rate: "rychlost řeči (např. +10%, -15%)",
		say: "okamžitě přečte zadaný text",
		help: "zobrazí podrobnou nápovědu",
	};

	pi.registerCommand("audio", {
		description:
			"pi-tts: předčítání odpovědí asistenta (TTS) přes Edge cloud nebo offline hlasy, Darth Vader režim",
		getArgumentCompletions: (prefix: string) => {
			const tokens = prefix.split(/\s+/).filter(Boolean);
			const trailingSpace = /\s$/.test(prefix);

			// Třetí slovo — např. /audio vader depth <auto|-3|-4>
			if (tokens.length > 2 || (trailingSpace && tokens.length === 2)) {
				const cmd = tokens[0]?.toLowerCase();
				const sub = tokens[1]?.toLowerCase();
				const arg = (tokens.length > 2 ? tokens[2] : "").toLowerCase();

				if (cmd === "vader" && sub === "depth") {
					const items = [
						{
							value: "auto",
							label: "auto",
							description: "automatická hloubka (0 na edge, -3 na native)",
						},
						{ value: "-1", label: "-1", description: "mírný posun (-1 půltón)" },
						{ value: "-2", label: "-2", description: "střední posun (-2 půltóny)" },
						{ value: "-3", label: "-3", description: "klasický Vader (-3 půltóny)" },
						{ value: "-4", label: "-4", description: "hluboký Vader (-4 půltóny)" },
					];
					const filtered = items.filter((i) => i.value.startsWith(arg));
					return filtered.length > 0 ? filtered : null;
				}
				return null;
			}

			// Druhé slovo — kontextové dokončování podle podpříkazu
			if (tokens.length > 1 || (trailingSpace && tokens.length === 1)) {
				const cmd = tokens[0]?.toLowerCase();
				const arg = (tokens.length > 1 ? tokens[1] : "").toLowerCase();

				if (cmd === "backend") {
					const items = [
						{
							value: "edge",
							label: "backend edge",
							description: "Microsoft Edge cloudové neurální hlasy",
						},
						{
							value: "native",
							label: "backend native",
							description: "offline systémové hlasy (Windows WinRT/SAPI5, Linux)",
						},
					];
					const filtered = items.filter((i) => i.value.startsWith(arg));
					return filtered.length > 0 ? filtered : null;
				}

				if (cmd === "vader") {
					const items = [
						{ value: "on", label: "vader on", description: "zapnout Vader efekt" },
						{ value: "off", label: "vader off", description: "vypnout Vader efekt" },
						{
							value: "depth",
							label: "vader depth",
							description: "nastavit hloubku posunu půltónů",
						},
					];
					const filtered = items.filter((i) => i.value.startsWith(arg));
					return filtered.length > 0 ? filtered : null;
				}

				if (cmd === "rate") {
					const items = [
						{
							value: "+0%",
							label: "rate +0%",
							description: "výchozí normální rychlost",
						},
						{ value: "+10%", label: "rate +10%", description: "+10 % zrychlení" },
						{ value: "+20%", label: "rate +20%", description: "+20 % zrychlení" },
						{ value: "-10%", label: "rate -10%", description: "-10 % zpomalení" },
						{ value: "-20%", label: "rate -20%", description: "-20 % zpomalení" },
					];
					const filtered = items.filter((i) => i.value.startsWith(arg));
					return filtered.length > 0 ? filtered : null;
				}

				if (cmd === "voice") {
					const items = [
						{
							value: "cs-CZ-AntoninNeural",
							label: "voice cs-CZ-AntoninNeural",
							description: "český mužský (Edge)",
						},
						{
							value: "cs-CZ-VlastaNeural",
							label: "voice cs-CZ-VlastaNeural",
							description: "český ženský (Edge)",
						},
						{
							value: "sk-SK-LukasNeural",
							label: "voice sk-SK-LukasNeural",
							description: "slovenský mužský (Edge)",
						},
						{
							value: "sk-SK-ViktoriaNeural",
							label: "voice sk-SK-ViktoriaNeural",
							description: "slovenský ženský (Edge)",
						},
						{
							value: "en-US-GuyNeural",
							label: "voice en-US-GuyNeural",
							description: "anglický mužský (Edge)",
						},
						{
							value: "en-US-JennyNeural",
							label: "voice en-US-JennyNeural",
							description: "anglický ženský (Edge)",
						},
					];
					const filtered = items.filter((i) =>
						i.value.toLowerCase().startsWith(arg),
					);
					return filtered.length > 0 ? filtered : null;
				}

				return null;
			}

			// První slovo — podpříkazy
			const typed = (tokens[0] ?? "").toLowerCase();
			const items = Object.entries(AUDIO_DOCS)
				.filter(([key]) => key.startsWith(typed))
				.map(([value, description]) => ({ value, label: value, description }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [subRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const sub = (subRaw ?? "").toLowerCase();
			const value = rest.join(" ").trim();

			switch (sub) {
				case "on":
					config.enabled = true;
					saveConfig(config);
					refreshTtsStatus(ctx);
					ctx.ui.notify("Audio TTS: ZAPNUTO (ON)", "info");
					break;
				case "off":
					config.enabled = false;
					saveConfig(config);
					stopSpeaking();
					refreshTtsStatus(ctx);
					ctx.ui.notify("Audio TTS: VYPNUTO (OFF)", "info");
					break;
				case "stop":
					stopSpeaking();
					ctx.ui.notify("Přehrávání zastaveno", "info");
					break;
				case "status":
					ctx.ui.notify(
						`TTS ${config.enabled ? "ON" : "OFF"} | backend=${config.backend} voice=${config.voice} rate=${config.rate} vader=${config.vader ? "on" : "off"} depth=${config.vaderDepth ?? "auto"}` +
							(lastSpokenAt
								? ` | naposledy mluvil ${new Date(lastSpokenAt).toLocaleTimeString()}`
								: "") +
							(lastError ? ` | poslední chyba: ${lastError}` : ""),
						"info",
					);
					break;
				case "voice":
					if (value) {
						config.voice = value;
						saveConfig(config);
						refreshTtsStatus(ctx);
						ctx.ui.notify(`Hlas nastaven na: ${value}`, "info");
					} else {
						ctx.ui.notify(`Aktuální hlas: ${config.voice}`, "info");
					}
					break;
				case "backend": {
					const valLower = value.toLowerCase();
					if (valLower === "edge" || valLower === "native") {
						config.backend = valLower;
						saveConfig(config);
						refreshTtsStatus(ctx);
						ctx.ui.notify(
							valLower === "edge"
								? "Backend nastaven na Edge (cloudové neurální hlasy)"
								: `Backend nastaven na native (offline ${getPlatformLabel()} hlasy)`,
							"info",
						);
					} else {
						ctx.ui.notify("Použití: /audio backend edge|native", "warning");
					}
					break;
				}
				case "vader": {
					const tokens = value.split(/\s+/).filter(Boolean);
					const mode = (tokens[0] ?? "").toLowerCase();
					const arg = (tokens[1] ?? "").toLowerCase();

					if (mode === "on" || mode === "true" || mode === "1") {
						config.vader = true;
						saveConfig(config);
						refreshTtsStatus(ctx);
						ctx.ui.notify("Vader hlas: ZAPNUTO (ON)", "info");
					} else if (mode === "off" || mode === "false" || mode === "0") {
						config.vader = false;
						saveConfig(config);
						refreshTtsStatus(ctx);
						ctx.ui.notify("Vader hlas: VYPNUTO (OFF)", "info");
					} else if (mode === "depth") {
						if (arg === "auto" || !arg) {
							config.vaderDepth = null;
							saveConfig(config);
							ctx.ui.notify("Vader hloubka: auto (0 na edge, -3 na native)", "info");
						} else if (Number.isFinite(Number(arg))) {
							config.vaderDepth = Number(arg);
							saveConfig(config);
							ctx.ui.notify(
								`Vader hloubka: ${config.vaderDepth} půltónů (záporná = hlubší)`,
								"info",
							);
						} else {
							ctx.ui.notify(
								`Vader hloubka je ${config.vaderDepth ?? "auto"}. Použití: /audio vader depth -3 (nebo auto)`,
								"warning",
							);
						}
					} else if (!mode) {
						config.vader = !config.vader;
						saveConfig(config);
						refreshTtsStatus(ctx);
						ctx.ui.notify(
							`Vader hlas: ${config.vader ? "ZAPNUTO (ON)" : "VYPNUTO (OFF)"}`,
							"info",
						);
					} else {
						ctx.ui.notify(
							`Vader hlas je ${config.vader ? "ZAPNUT" : "VYPNUT"}, hloubka ${config.vaderDepth ?? "auto"}. Použití: /audio vader on|off|depth <půltóny>`,
							"info",
						);
					}
					break;
				}
				case "rate":
					if (/^[+-]\d+%$/.test(value)) {
						config.rate = value;
						saveConfig(config);
						ctx.ui.notify(`Rychlost řeči nastavena na ${value}`, "info");
					} else {
						ctx.ui.notify("Použití: /audio rate +10% (nebo -10%)", "warning");
					}
					break;
				case "say":
					if (value) {
						await speak(value);
						ctx.ui.notify("Přehrávám text…", "info");
					} else {
						ctx.ui.notify("Použití: /audio say <text>", "warning");
					}
					break;
				case "help":
				default:
					ctx.ui.notify(
						[
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
							`Nastavení: backend=${config.backend} | hlas=${config.voice} | rychlost=${config.rate} | vader=${config.vader ? "ON" : "OFF"}${config.vaderDepth === null ? "" : ` (${config.vaderDepth})`}`,
							lastError ? `Poslední chyba: ${lastError}` : "Bez chyb.",
						].join("\n"),
						"info",
					);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		refreshTtsStatus(ctx);
	});
}

# pi-tts

Text-to-speech for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent):
speaks the final assistant answer once the agent settles, and can be driven
manually via `/audio`.

- **Edge backend** — Microsoft cloud neural voices via `edge-tts` (needs network + Python)
- **Native backend** — fully offline: Windows WinRT (OneCore voices, e.g. cs-CZ
  Jakub) with SAPI5 fallback; Linux `espeak-ng`/`espeak` (voice, rate and pitch
  derived from the configured voice's locale) with a `spd-say` streaming fallback
- **Vader mode** — ffmpeg filter chain (EQ + flanger + echo + rubberband pitch)
  tuned for a Darth Vader delivery; works on edge and on any native backend that
  can render a WAV (WinRT/SAPI5/espeak); falls back to plain audio without ffmpeg

## Requirements

- Python 3 on PATH (`python` on Windows, `python3` or `python` elsewhere)
- `pip install -r requirements.txt` (only for the `edge` backend)
- ffmpeg + ffplay — optional, needed for the Vader effect and as the preferred player
- Native backend engines:
  - Windows: PowerShell 5.1 (`powershell.exe`, preinstalled)
  - Linux: `espeak-ng` or `espeak` (recommended — enables voice/rate/pitch control
    and native Vader), otherwise `spd-say` as a plain streaming fallback

## Install

```bash
pi install git:github.com/mastnacek/pi-tts
```

## /audio commands

| Command | Effect |
|---|---|
| `/audio on` / `off` | Enable/disable speaking (persisted) |
| `/audio stop` | Stop current playback |
| `/audio status` | State, backend, voice, rate, vader, last error |
| `/audio voice <name>` | Set voice (e.g. `cs-CZ-AntoninNeural`); no arg shows current |
| `/audio backend edge\|native` | Cloud neural vs offline engine |
| `/audio vader on\|off` | Toggle the Vader effect |
| `/audio vader depth <semitones>` | Extra pitch shift; negative = deeper; `auto` = 0 on edge, −3 on native |
| `/audio rate ±N%` | Speech rate (e.g. `+10%`, `-10%`) |
| `/audio say <text>` | Speak text immediately |

A new user prompt interrupts playback. Config persists in
`~/.pi/agent/pi-tts.json`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PI_TTS_VOICE` | `cs-CZ-AntoninNeural` | Default voice |
| `PI_TTS_RATE` | `+0%` | Default rate |
| `PI_TTS_PITCH` | `+0Hz` | Default pitch |
| `PI_TTS_MAXLEN` | `1500` | Max characters spoken |
| `PI_TTS_BACKEND` | `edge` | Default backend |
| `PI_TTS_VADER` | off | Start with Vader on |
| `PI_TTS_VADER_PITCH` | `-30Hz` | Vader base pitch |
| `PI_TTS_VADER_RATE` | `-30%` | Vader base rate |
| `PI_TTS_VADER_VOLUME` | `61.5` | Vader make-up gain (EQ cuts ~35 dB) |
| `PI_TTS_VADER_DEPTH` | `0` edge / `-3` native | Extra semitone shift |
| `PI_TTS_NATIVE_API` | `auto` | `winrt` / `sapi` / `auto` |
| `PI_TTS_CA_BUNDLE` | — | Extra CA bundle for TLS-intercepting antivirus proxies |

## speak.py standalone

```bash
python speak.py --voice cs-CZ-VlastaNeural --rate -10% "Text"
python speak.py --file response.txt --backend native --vader --depth -5
```

Markdown is stripped (code blocks become "code omitted"), text is truncated at
`PI_TTS_MAXLEN`.

## License

MIT

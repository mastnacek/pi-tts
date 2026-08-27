#!/usr/bin/env python3
"""
pi-tts speaker – cross-platform TTS helper for the pi-tts extension.
Adapted from fish_tts.py (Edge TTS).

Usage:
  python speak.py "Text to read"
  python speak.py --file response.txt
  python speak.py --backend native "Text"
  python speak.py --voice cs-CZ-VlastaNeural --rate -10% "Text"
  python speak.py --vader "Text"

Backends:
  edge   – edge-tts, Microsoft's cloud neural voices (needs network)
  native – fully offline. On Windows it renders through WinRT, which sees the
           OneCore voices from Settings -> Time & language -> Speech (that is
           where cs-CZ Jakub lives); SAPI5 is the fallback, and it only knows
           the en-US desktop voices. Linux uses spd-say / espeak.

Vader mode (--vader):
  Applies the ffmpeg filter chain tuned in the Vader Voice Tuner and lowers
  pitch/rate to the Vader defaults unless they were given explicitly.
  Works on edge and on Windows native; needs ffmpeg, and falls back to the
  unprocessed audio if it is missing.
"""

import argparse
import asyncio
import os
import platform
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import time

WINRT_PS1 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "winrt_speak.ps1")

DEFAULT_VOICE = os.environ.get("PI_TTS_VOICE", "cs-CZ-AntoninNeural")
DEFAULT_PITCH = os.environ.get("PI_TTS_PITCH", "+0Hz")
DEFAULT_RATE = os.environ.get("PI_TTS_RATE", "+0%")
try:
    MAX_TEXT_LENGTH = int(os.environ.get("PI_TTS_MAXLEN", "1500"))
except ValueError:
    MAX_TEXT_LENGTH = 1500

# Cooperative stop: the extension touches this file to make us kill the
# player immediately. More reliable than parent-side tree kills, which can
# miss re-parented or stale players.
STOP_FILE = os.environ.get("PI_TTS_STOP_FILE")
STOP_POLL_SECONDS = 0.15
PLAY_TIMEOUT_SECONDS = 120


def _stop_requested() -> bool:
    return bool(STOP_FILE) and os.path.exists(STOP_FILE)


def _wait_playing(proc: subprocess.Popen) -> None:
    """Wait for the player, honoring the stop file and a hard timeout."""
    deadline = time.monotonic() + PLAY_TIMEOUT_SECONDS
    while proc.poll() is None:
        if _stop_requested() or time.monotonic() > deadline:
            proc.kill()
            return
        time.sleep(STOP_POLL_SECONDS)


# --- Vader mode -------------------------------------------------------------
# Voice params the Vader effect assumes; used only when the caller left
# pitch/rate at the neutral defaults.
VADER_PITCH = os.environ.get("PI_TTS_VADER_PITCH", "-30Hz")
VADER_RATE = os.environ.get("PI_TTS_VADER_RATE", "-30%")
# The EQ chain cuts ~35 dB out of the speech band, so the make-up gain is large
# by design — measured output peaks around -9 dBFS, i.e. no clipping.
VADER_VOLUME = os.environ.get("PI_TTS_VADER_VOLUME", "61.5")


# Extra pitch shift in semitones, applied before the EQ. The edge voice reaches
# ~118 Hz on its own, but the OneCore engine clamps SSML pitch at that same
# floor (-30Hz and -50% both bottom out there), so the native path needs the
# shift done in ffmpeg instead. Negative = deeper.
def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


VADER_DEPTH_EDGE = _env_float("PI_TTS_VADER_DEPTH", 0.0)
VADER_DEPTH_NATIVE = _env_float("PI_TTS_VADER_DEPTH", -3.0)

# ffmpeg filter chain – tuned in the Vader Voice Tuner (from fish_tts.py)
VADER_FILTER = (
    "equalizer=f=50:t=q:w=0.8:g=10,"
    "equalizer=f=100:t=q:w=0.8:g=5,"
    "equalizer=f=400:t=q:w=1:g=-16,"
    "equalizer=f=1000:t=q:w=1:g=-14,"
    "equalizer=f=3000:t=q:w=1:g=5,"
    "equalizer=f=6000:t=q:w=1:g=4,"
    "lowpass=f=4700,"
    "asoftclip=type=atan:threshold=0.98:param=0.1,"
    "flanger=delay=4:depth=2.5:regen=15:width=55:speed=0.35:shape=sinusoidal:phase=50,"
    "aecho=0.8:0.88:5:0.61,"
    "aecho=0.8:0.88:105:0.13,"
    "aecho=0.6:0.6:180:0.08,"
    "volume={volume}"
)


def clean_markdown(text: str) -> str:
    """Strip markdown syntax for cleaner TTS output."""
    # Strip unprintable control characters
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    text = re.sub(r"```[\s\S]*?```", " code omitted. ", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"#{1,6}\s*", "", text)
    text = re.sub(r"\*{1,2}([^*]+)\*{1,2}", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.M)
    # Strip markdown table rows
    text = re.sub(r"^\s*\|.*\|\s*$", "", text, flags=re.M)
    text = re.sub(r"^\s*[-:| ]{3,}\s*$", "", text, flags=re.M)
    # Normalize paragraphs
    paragraphs = [p.strip() for p in re.split(r"\n{2,}", text) if p.strip()]
    cleaned_paragraphs = []
    for p in paragraphs:
        cleaned = re.sub(r"\s*\n\s*", " ", p)
        cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
        if cleaned:
            cleaned_paragraphs.append(cleaned)
    return "\n\n".join(cleaned_paragraphs)


def have(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def play_file(path: str):
    """Play audio file with whatever player exists, stoppable via the stop file."""
    if have("ffplay"):
        proc = subprocess.Popen(
            ["ffplay", "-autoexit", "-nodisp", "-loglevel", "quiet", path]
        )
    elif platform.system() == "Windows":
        ps_path = path.replace("'", "''")
        ps = (
            "Add-Type -AssemblyName presentationCore;"
            "$p = New-Object System.Windows.Media.MediaPlayer;"
            f"$p.Open([uri]'{ps_path}'); $p.Play(); Start-Sleep 1;"
            "while ($p.NaturalDuration.HasTimeSpan -eq $false) { Start-Sleep -Milliseconds 200 };"
            "Start-Sleep $p.NaturalDuration.TimeSpan.TotalSeconds; $p.Close()"
        )
        proc = subprocess.Popen(["powershell", "-NoProfile", "-Command", ps])
    elif platform.system() == "Darwin" and have("afplay"):
        proc = subprocess.Popen(["afplay", path])
    elif path.endswith(".wav") and have("aplay"):
        proc = subprocess.Popen(["aplay", "-q", path])
    elif have("mpg123"):
        proc = subprocess.Popen(["mpg123", "-q", path])
    else:
        sys.stderr.write(
            "pi-tts: no audio player found (need ffplay/mpg123/aplay/afplay)\n"
        )
        return
    _wait_playing(proc)


def apply_vader(raw_path: str, out_path: str, depth: float = 0.0) -> str:
    """Run the Vader filter chain over raw_path; return the file to play."""
    if not have("ffmpeg"):
        sys.stderr.write("pi-tts: ffmpeg not found, playing without Vader effect\n")
        return raw_path

    chain = VADER_FILTER.format(volume=VADER_VOLUME)
    # rubberband keeps the duration intact and, with formants shifted along,
    # deepens the voice rather than just detuning it.
    attempts = [chain]
    if depth:
        ratio = 2 ** (depth / 12)
        attempts.insert(0, f"rubberband=pitch={ratio:.6f}:formant=shifted," + chain)

    for i, af in enumerate(attempts):
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", raw_path, "-af", af, out_path],
            capture_output=True,
            timeout=90,
        )
        if result.returncode == 0:
            return out_path
        detail = result.stderr.decode("utf-8", errors="replace").strip().splitlines()
        last = detail[-1] if detail else "?"
        if i + 1 < len(attempts):
            # Most likely an ffmpeg build without librubberband — drop the
            # pitch shift rather than losing the whole effect.
            sys.stderr.write(
                f"pi-tts: pitch shift unavailable ({last}), using plain Vader\n"
            )
        else:
            sys.stderr.write(f"pi-tts: Vader filter failed: {last}\n")
    return raw_path


def is_cert_error(exc: BaseException) -> bool:
    """True if exc (or anything it wraps) is a TLS certificate failure."""
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        if isinstance(exc, ssl.SSLCertVerificationError):
            return True
        next_exc = exc.__cause__ or exc.__context__
        if next_exc is None:
            break
        exc = next_exc
    return False


def relaxed_ssl_context() -> ssl.SSLContext:
    """
    Context that tolerates a local TLS-inspecting antivirus proxy (Avast Web
    Shield and friends). Their generated root sits in the Windows store but
    trips Python 3.13's VERIFY_X509_STRICT — that one flag is dropped, while
    chain building and hostname verification stay on.
    """
    ctx = ssl.create_default_context()  # includes the Windows cert store
    try:
        import certifi

        ctx.load_verify_locations(certifi.where())
    except (ImportError, OSError):
        pass
    extra = os.environ.get("PI_TTS_CA_BUNDLE")
    if extra and os.path.exists(extra):
        ctx.load_verify_locations(extra)
    ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return ctx


def modulate_chunk_prosody(
    text: str, base_rate: str, base_pitch: str
) -> tuple[str, str]:
    """
    Apply natural conversational pitch/rate modulation for Edge voices
    when base rate and pitch are at default values.
    """
    rate = base_rate
    pitch = base_pitch
    if base_rate in ("+0%", "0%") and base_pitch in ("+0Hz", "0Hz"):
        stripped = text.strip().rstrip("\"'“”»)]}")
        # Greetings and confirmations
        if re.match(
            r"^(ahoj|čau|dobrý den|zdravím|hello|hi|hey|rozumím|hotovo|jasně|skvěle|perfektní|jistě|sure|done|okay|ok)\b",
            stripped,
            re.I,
        ):
            rate = "+5%"
            pitch = "+3Hz"
        elif stripped.endswith("?"):
            pitch = "+3Hz"
        elif stripped.endswith("!"):
            rate = "+5%"
            pitch = "+2Hz"
    return rate, pitch


SENTENCE_SPLIT_RE = re.compile(
    r"(?<="
    r"(?<!\b(?:např|apod|prof))"
    r"(?<!\b(?:tzv|atd|doc|mgr|ing|etc|mrs))"
    r"(?<!\b(?:tj|vs|dr|mr|ms|eg|ie|bc))"
    r"(?<!\b[a-zA-Z\d]\.[a-zA-Z])"
    r"(?<!\b[vč])"
    r"(?<!\d)"
    r"[.!?]"
    r")\s+",
    re.IGNORECASE,
)


def split_paragraphs_and_sentences(text: str, max_chunk_len: int = 350) -> list[str]:
    """
    Split text into natural chunks (paragraphs/sentences) for pipelined streaming playback.
    Avoids splitting on common abbreviations (např., tzv., atd., e.g., v1.2, etc.).
    """
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: list[str] = []
    for p in paragraphs:
        if len(p) <= max_chunk_len:
            chunks.append(p)
        else:
            sentences = [s.strip() for s in SENTENCE_SPLIT_RE.split(p) if s.strip()]
            current: list[str] = []
            curr_len = 0
            for s in sentences:
                if curr_len + len(s) > max_chunk_len and current:
                    chunks.append(" ".join(current))
                    current = [s]
                    curr_len = len(s)
                else:
                    current.append(s)
                    curr_len += len(s)
            if current:
                chunks.append(" ".join(current))
    return chunks or [text]


async def speak_edge(
    text: str,
    voice: str,
    rate: str,
    pitch: str,
    vader: bool = False,
    depth: float = 0.0,
    prosody: bool = True,
):
    import edge_tts  # pyright: ignore[reportMissingImports] — runtime dep from requirements.txt
    import edge_tts.communicate as edge_communicate  # pyright: ignore[reportMissingImports]

    # aiohttp's proactor transport raises ConnectionResetError while tearing
    # down an already-finished stream on Windows; it is pure noise.
    loop = asyncio.get_running_loop()
    loop.set_exception_handler(
        lambda lp, ctx: (
            None
            if isinstance(ctx.get("exception"), ConnectionResetError)
            else lp.default_exception_handler(ctx)
        )
    )

    chunks = split_paragraphs_and_sentences(text)
    tmp_dir = tempfile.mkdtemp(prefix="pitts_")

    try:

        async def synth_one(chunk_text: str, idx: int) -> str:
            chunk_rate = rate
            chunk_pitch = pitch
            if prosody and not vader:
                chunk_rate, chunk_pitch = modulate_chunk_prosody(
                    chunk_text, rate, pitch
                )

            raw_path = os.path.join(tmp_dir, f"chunk_{idx}.mp3")
            communicate = edge_tts.Communicate(
                chunk_text, voice, pitch=chunk_pitch, rate=chunk_rate
            )
            try:
                await communicate.save(raw_path)
            except Exception as e:
                if is_cert_error(e):
                    sys.stderr.write(
                        "pi-tts: TLS interception detected, retrying with system CA store\n"
                    )
                    edge_communicate._SSL_CTX = relaxed_ssl_context()
                    communicate = edge_tts.Communicate(
                        chunk_text, voice, pitch=chunk_pitch, rate=chunk_rate
                    )
                    await communicate.save(raw_path)
                else:
                    raise

            if vader:
                out_vader = os.path.join(tmp_dir, f"vader_{idx}.mp3")
                return apply_vader(raw_path, out_vader, depth)
            return raw_path

        # Launch concurrent background synthesis tasks for all chunks
        synth_tasks = [
            asyncio.create_task(synth_one(c, i)) for i, c in enumerate(chunks)
        ]

        # Sequentially stream playback as each chunk finishes synthesis
        for i, task in enumerate(synth_tasks):
            if _stop_requested():
                for pending in synth_tasks[i:]:
                    pending.cancel()
                return
            audio_path = await task
            if _stop_requested():
                return
            await asyncio.to_thread(play_file, audio_path)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def write_temp_text(text: str) -> str:
    fd, path = tempfile.mkstemp(prefix="pitts_", suffix=".txt")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def synth_winrt(text: str, voice: str, rate: str, pitch: str, out_wav: str) -> bool:
    """
    Render speech to out_wav via the WinRT engine, which — unlike SAPI5 — can
    see the OneCore voices from Windows Settings (that is where cs-CZ Jakub
    lives). Returns False if it is unavailable so the caller can fall back.
    """
    if platform.system() != "Windows" or not os.path.exists(WINRT_PS1):
        return False

    args = [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        WINRT_PS1,
    ]
    # An edge-style name (cs-CZ-AntoninNeural) has no WinRT counterpart, but its
    # locale does — match on that instead of the meaningless display name.
    locale = re.match(r"^([a-z]{2}-[A-Za-z]{2})-", voice or "")
    if locale:
        args += ["-Language", locale.group(1)]
    elif voice:
        args += ["-Voice", voice]
    if rate and rate not in ("+0%", "0%"):
        args += ["-Rate", rate]
    if pitch and pitch not in ("+0Hz", "0Hz"):
        args += ["-Pitch", pitch]

    txt_path = write_temp_text(text)
    try:
        result = subprocess.run(
            args + ["-TextFile", txt_path, "-Out", out_wav],
            capture_output=True,
            timeout=120,
        )
    finally:
        os.unlink(txt_path)

    if result.returncode != 0 or not os.path.exists(out_wav):
        detail = result.stderr.decode("utf-8", errors="replace").strip().splitlines()
        sys.stderr.write(
            f"pi-tts: WinRT synthesis failed: {detail[-1] if detail else '?'}\n"
        )
        return False
    return True


def _locale_of(voice: str | None) -> str | None:
    """Extract an espeak-style language tag from a voice name.

    Edge-style names carry the locale: cs-CZ-AntoninNeural -> cs-cz,
    en-GB-RyanNeural -> en-gb. Plain locale codes (cs, en-US) are kept.
    Windows OneCore display names (Microsoft Jakub) are ignored.
    """
    if not voice:
        return None
    m = re.match(r"^([a-z]{2}(?:-[A-Za-z]{2})?)-", voice)
    if m:
        return m.group(1).lower()
    if re.match(r"^[a-z]{2}(?:-[a-zA-Z]{2})?$", voice):
        return voice.lower()
    return None


def _hz_of(pitch: str | None) -> float | None:
    m = re.match(r"([+-]?\d+)Hz", pitch or "")
    try:
        return float(m.group(1)) if m else None
    except ValueError:
        return None


def synth_espeak(
    text: str,
    voice: str | None,
    rate_pct: int | None,
    pitch_hz: float | None,
    out_wav: str,
) -> bool:
    """Render speech to out_wav via espeak-ng/espeak. Returns False if absent."""
    binary = (
        "espeak-ng" if have("espeak-ng") else ("espeak" if have("espeak") else None)
    )
    if not binary:
        return False
    args = [binary]
    locale = _locale_of(voice)
    if locale:
        args += ["-v", locale]
    if rate_pct is not None:
        # espeak speaks words-per-minute; ~170 is the default voice pace.
        wpm = max(80, min(350, 170 + rate_pct * 20))
        args += ["-s", str(wpm)]
    if pitch_hz is not None:
        # espeak takes a 0..99 scale around ~50 neutral; +-50Hz spans it well.
        p = max(0, min(99, round(50 + pitch_hz / 2)))
        args += ["-p", str(p)]
    args += ["-w", out_wav]
    txt_path = write_temp_text(text)
    try:
        result = subprocess.run(
            args + ["-f", txt_path], capture_output=True, timeout=120
        )
    finally:
        os.unlink(txt_path)
    if result.returncode != 0 or not os.path.exists(out_wav):
        detail = result.stderr.decode("utf-8", errors="replace").strip().splitlines()
        sys.stderr.write(
            f"pi-tts: espeak synthesis failed: {detail[-1] if detail else '?'}\n"
        )
        return False
    return True


def stream_spd_say(text: str, voice: str | None, rate_pct: int | None) -> bool:
    """Stream directly through speech-dispatcher. Last-resort Linux path."""
    if not have("spd-say"):
        return False
    args = ["spd-say", "-e"]
    locale = _locale_of(voice)
    if locale:
        args += ["-l", locale.split("-")[0]]
    if rate_pct is not None:
        args += ["-r", str(rate_pct * 10)]  # spd-say uses -100..100
    args.append(text)
    proc = subprocess.Popen(args)
    _wait_playing(proc)
    return True


def synth_sapi(
    text: str, voice: str | None, rate_pct: int | None, out_wav: str
) -> bool:
    """Render speech to out_wav via System.Speech (SAPI5). Windows only."""
    txt_path = write_temp_text(text)
    ps_txt_path = txt_path.replace("'", "''")
    ps_out_wav = out_wav.replace("'", "''")
    voice_escaped = voice.replace("'", "''") if voice else ""
    voice_part = (
        f"try {{ $s.SelectVoice('{voice_escaped}') }} catch {{}};" if voice else ""
    )
    rate_part = f"$s.Rate = {rate_pct};" if rate_pct is not None else ""
    ps = (
        "Add-Type -AssemblyName System.Speech;"
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        f"$s.SetOutputToWaveFile('{ps_out_wav}');"
        f"{voice_part}{rate_part}"
        f"$t = [IO.File]::ReadAllText('{ps_txt_path}', [Text.Encoding]::UTF8);"
        "$s.Speak($t); $s.Dispose()"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True,
            timeout=120,
        )
    finally:
        os.unlink(txt_path)
    return result.returncode == 0 and os.path.exists(out_wav)


def speak_native(
    text: str,
    voice: str | None,
    rate: str,
    pitch: str,
    rate_pct: int | None,
    vader: bool = False,
    depth: float = 0.0,
):
    system = platform.system()
    if system == "Windows":
        tmp_dir = tempfile.mkdtemp(prefix="pitts_")
        wav_path = os.path.join(tmp_dir, "native.wav")
        try:
            api = os.environ.get("PI_TTS_NATIVE_API", "auto").lower()
            ok = False
            if api in ("auto", "winrt"):
                ok = synth_winrt(text, voice or "", rate, pitch, wav_path)
            if not ok and api in ("auto", "sapi"):
                # SAPI5 cannot see OneCore voices, so drop an edge-style name.
                sapi_voice = (
                    voice if voice and not re.match(r"^[a-z]{2}-", voice) else None
                )
                ok = synth_sapi(text, sapi_voice, rate_pct, wav_path)
            if not ok:
                sys.stderr.write("pi-tts: native synthesis failed\n")
                return
            if _stop_requested():
                return
            play_path = (
                apply_vader(wav_path, os.path.join(tmp_dir, "vader.mp3"), depth)
                if vader
                else wav_path
            )
            play_file(play_path)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
    else:
        # Linux / other POSIX: render offline via espeak when available so the
        # Vader chain and the shared player apply, exactly like the Windows path.
        tmp_dir = tempfile.mkdtemp(prefix="pitts_")
        wav_path = os.path.join(tmp_dir, "native.wav")
        try:
            ok = synth_espeak(text, voice, rate_pct, _hz_of(pitch), wav_path)
            if ok:
                if _stop_requested():
                    return
                play_path = (
                    apply_vader(wav_path, os.path.join(tmp_dir, "vader.mp3"), depth)
                    if vader
                    else wav_path
                )
                play_file(play_path)
            else:
                if vader:
                    sys.stderr.write(
                        "pi-tts: needs espeak(-ng) for native Vader, speaking plain\n"
                    )
                if not stream_spd_say(text, voice, rate_pct):
                    sys.stderr.write(
                        "pi-tts: no native TTS found (need espeak-ng or spd-say)\n"
                    )
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description="pi-tts speaker")
    ap.add_argument("text", nargs="*", help="Text to speak")
    ap.add_argument("--file", help="Read text from file (UTF-8)")
    ap.add_argument(
        "--backend",
        choices=["edge", "native"],
        default=os.environ.get("PI_TTS_BACKEND", "edge"),
    )
    ap.add_argument("--voice", default=None)
    ap.add_argument("--rate", default=DEFAULT_RATE, help="edge rate, e.g. -10%%")
    ap.add_argument("--pitch", default=DEFAULT_PITCH)
    ap.add_argument(
        "--vader",
        action=argparse.BooleanOptionalAction,
        default=os.environ.get("PI_TTS_VADER", "").lower() in ("1", "true", "on"),
        help="apply the Darth Vader ffmpeg effect (--vader / --no-vader)",
    )
    ap.add_argument(
        "--prosody",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="apply natural conversational prosody modulation for Edge voices",
    )
    ap.add_argument(
        "--depth",
        type=float,
        default=None,
        help="extra Vader pitch shift in semitones, negative is deeper "
        "(default: 0 on edge, -3 on native)",
    )
    args = ap.parse_args()

    if args.file:
        try:
            with open(args.file, encoding="utf-8") as f:
                text = f.read()
        except OSError as e:
            sys.stderr.write(f"pi-tts: cannot read file: {e}\n")
            sys.exit(1)
    else:
        text = " ".join(args.text)

    text = clean_markdown(text.strip())
    if not text:
        return
    if len(text) > MAX_TEXT_LENGTH:
        truncated = text[:MAX_TEXT_LENGTH]
        last_space = truncated.rfind(" ")
        if last_space > (MAX_TEXT_LENGTH * 4) // 5:
            text = truncated[:last_space] + "..."
        else:
            text = truncated + "..."

    voice = args.voice or DEFAULT_VOICE

    rate, pitch = args.rate, args.pitch
    if args.vader:
        # The effect is tuned for a slow, low delivery — supply it unless the
        # caller asked for a specific rate/pitch.
        if rate in ("+0%", "0%"):
            rate = VADER_RATE
        if pitch in ("+0Hz", "0Hz"):
            pitch = VADER_PITCH

    is_native = args.backend == "native"
    depth = args.depth
    if depth is None:
        depth = VADER_DEPTH_NATIVE if is_native else VADER_DEPTH_EDGE

    try:
        if is_native:
            # Parse edge-style rate (-10%) into a SAPI5 int for the fallback path
            rate_pct = None
            m = re.match(r"([+-]\d+)%", rate)
            if m:
                rate_pct = max(-10, min(10, int(m.group(1)) // 10))
            speak_native(
                text, voice, rate, pitch, rate_pct, vader=args.vader, depth=depth
            )
        else:
            asyncio.run(
                speak_edge(
                    text,
                    voice,
                    rate,
                    pitch,
                    vader=args.vader,
                    depth=depth,
                    prosody=args.prosody,
                )
            )
    except Exception as e:
        sys.stderr.write(f"pi-tts error: {e}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()

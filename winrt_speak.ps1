<#
    Synthesize text to a WAV file using the WinRT speech engine.

    Unlike System.Speech (SAPI5), this sees the OneCore voices installed via
    Settings -> Time & language -> Speech, which is where the non-English
    voices (e.g. Microsoft Jakub, cs-CZ) live.

    Must run under Windows PowerShell 5.1 (powershell.exe) — pwsh lacks the
    WinRT projection this relies on.
#>
param(
    [Parameter(Mandatory = $true)][string]$TextFile,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Voice = "",
    [string]$Language = "",
    [string]$Rate = "",
    [string]$Pitch = "",
    [switch]$ListVoices
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($op, $type) {
    $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    $t.Result
}

[Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage, ContentType = WindowsRuntime] | Out-Null

$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices

if ($ListVoices) {
    $voices | ForEach-Object { "{0}`t{1}" -f $_.DisplayName, $_.Language }
    exit 0
}

# Voice pick: explicit name, then exact locale, then language family.
$sel = $null
if ($Voice) { $sel = $voices | Where-Object { $_.DisplayName -like "*$Voice*" } | Select-Object -First 1 }
if (-not $sel -and $Language) {
    $sel = $voices | Where-Object { $_.Language -eq $Language } | Select-Object -First 1
    if (-not $sel) {
        $prefix = $Language.Split('-')[0] + '-*'
        $sel = $voices | Where-Object { $_.Language -like $prefix } | Select-Object -First 1
    }
}

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
if ($sel) { $synth.Voice = $sel }
$lang = if ($sel) { $sel.Language } else { "en-US" }

$text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)

try {
    if ($Rate -or $Pitch) {
        $attrs = ""
        if ($Rate) { $attrs += " rate='$Rate'" }
        if ($Pitch) { $attrs += " pitch='$Pitch'" }
        $escaped = [Security.SecurityElement]::Escape($text)
        $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='$lang'>" +
        "<prosody$attrs>$escaped</prosody></speak>"
        $stream = Await $synth.SynthesizeSsmlToStreamAsync($ssml) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
    }
    else {
        $stream = Await $synth.SynthesizeTextToStreamAsync($text) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
    }

    $size = [uint32]$stream.Size
    $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
    Await $reader.LoadAsync($size) ([uint32]) | Out-Null
    $bytes = New-Object byte[] $size
    $reader.ReadBytes($bytes)
    [IO.File]::WriteAllBytes($Out, $bytes)
}
finally {
    $synth.Dispose()
}

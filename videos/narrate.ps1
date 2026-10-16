param([string]$Python)
$ErrorActionPreference = 'Stop'
if ($Python) { $env:HYPERFRAMES_PYTHON = $Python }
foreach ($project in @('platform-explainer', 'platform-short')) {
    $projectRoot = Join-Path $PSScriptRoot $project
    $voiceRoot = Join-Path $projectRoot '.media/audio/voice'
    $voices = @()
    $frame = 0
    foreach ($text in (Get-ChildItem -LiteralPath $voiceRoot -Filter '*.txt' | Sort-Object Name)) {
        $frame++
        $wav = Join-Path $voiceRoot "$($text.BaseName).wav"
        $result = npx --yes hyperframes@0.8.164 tts --text-file $text.FullName --voice am_michael --output $wav --json
        if ($LASTEXITCODE -ne 0) { throw "Narration failed: $($text.Name)" }
        $audio = $result | ConvertFrom-Json
        $voices += @{ frame = $frame; path = ".media/audio/voice/$($text.BaseName).wav"; duration_s = $audio.durationSeconds; words = @() }
    }
    $meta = @{ bgm = $null; bgm_pending = $false; voices = $voices; sfx = @() }
    $meta | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $projectRoot 'audio_meta.json')
}

# Platform product films

Two finished videos accompany the public landing page:

- `platform-explainer` — landscape, 1920 × 1080, 60 seconds; four scenes follow an app from its server to deployment, operations, and scoped MCP access.
- `platform-short` — portrait, 1080 × 1920, approximately 22 seconds; two scenes composed for a phone rather than cropped from the landscape film.

Both films close with “Build on your terms” and the product homepage. The tone is clear, friendly, and lightly playful. These are explanatory wireframe illustrations, not recordings of the dashboard. Product statements come from this repository's docs and implementation. There are no customer quotes, invented adoption numbers, performance claims, or distributed-tracing promises.

The published MP4s, poster, and English WebVTT captions live in `../platform/portal/public/media/`. Each project contains its editable HyperFrames composition, brief, storyboard, script, local fonts, narration, score, and audio mix. CLI scripts pin HyperFrames 0.8.167. Video runs at 24 fps. Motion illustrates request/response flows, application deployment, and command validation; all activity is conceptual.

## Re-render an existing film

From either project directory:

```sh
npm install
npm run check
npx hyperframes@0.8.167 snapshot --at "3,7,12"  # choose times inside the film
npx hyperframes@0.8.167 render --fps=24 --quality=high --output=renders/video.mp4
```

Review the contact sheet and the transitions before rendering. The original render was checked for layout, runtime errors, and contrast; audio is grouped and the music has a voiceover carve. No external service or paid API is required for these checked-in projects.

## Audio provenance and regeneration

- Narration: Microsoft neural voice `en-US-AvaMultilingualNeural`, generated through `edge-tts`. The user chose Ava after hearing samples and asked for a less mechanical delivery. `pronunciation.json` separates the spelling spoken by TTS from official names in captions, including “Argo, see dee.” No cloned person's voice.
- Music: an original 96 BPM score synthesized by `create-score.py`, using warm pads, a plucked arpeggio, bass, and restrained percussion. It uses no external music samples.
- One subtle UI click: the bundled HyperFrames SFX library, resolved with `media-use` to `.media/audio/sfx/sfx_001.mp3`.
- Fonts: Space Grotesk, Archivo Black, and JetBrains Mono from the official Google Fonts repository. Their OFL licenses are included beside the font files.
- Logo: the existing Platform logo from this repository. GSAP's distributed source header is retained in `assets/gsap.min.js`.

To regenerate narration, install `requirements-audio.txt` in a local virtual environment, then run `python videos/narrate-neural.py` from the repository root. Use `--project platform-explainer --frame 4` (or `--project platform-short --frame 2`) to regenerate just one scene. This reads the existing `SCRIPT.md` files, uses the online speech service, and freezes WAV files and native sentence timestamps. Re-rendering checked-in audio needs no online speech service. `node videos/sync-audio.mjs` places the new narration in the scenes and generates WebVTT captions from those timestamps. It preserves the HTML layouts and visual choreography. A changed narrator may need new scene durations; the sync script rejects narration that exceeds the 15-second main-video scenes.

`prepare.mjs` is the initial planning scaffold and intentionally resets the planning files. Preserve scene edits before using it. `narrate.ps1` is the original local Kokoro experiment; its mechanical delivery was replaced after review.

Run `python videos/create-score.py` to regenerate the original score using the full timeline duration. The checked-in MP3 bed remains available for direct re-renders; the Python script generates a WAV bed and updates the audio plan. Encode it to MP3 if replacing the checked-in bed. If reassembling the project, run `node videos/finalize.mjs` afterward to restore safe DOM IDs, local GSAP, and narration-group membership, then `node videos/sync-audio.mjs` and the HyperFrames audio skill's `carve.mjs` before checking. Reassembly replaces the root audio-mix attributes.

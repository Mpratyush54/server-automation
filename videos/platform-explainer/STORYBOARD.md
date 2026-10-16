---
format: 1920x1080
duration: 60s
message: "Your server. Your apps. One connected control plane."
arc: "Outcome → Mechanism → Operations → Control → CTA"
audience: "Developers running their own infrastructure"
mode: autonomous
music: "Original restrained electronic instrumental"
captions: none
---

## Video direction
Cream canvas, ink wireframes, coral emphasis. Bold, readable developer editorial. Four beats for landscape, two for portrait. All visual props must come from actual repository entities. Clean hard cuts between frames; no cross-frame handoff. Conceptual diagrams, not claimed real UI. Each scene develops in three phases. Narration is local Ava (Microsoft neural voice). An original score runs under it; use the voiceover carve before checks. Closed captions are delivered as WebVTT and the website includes the full transcript.

## Frame 1 — Your app deserves a home you control

- scene: Your app deserves a home you control
- duration: 15s
- poster: 7s
- transition_in: cut
- status: animated
- src: compositions/frames/01-own.html
- voiceover: "Your app deserves a home you control. Platform turns your own Ubuntu server into a connected developer platform, with Kubernetes underneath and one place to manage it."
- asset_candidates: logo-light.png
- focal: Your app deserves a home you control
- roles: logo-light.png — supporting brand lockup; wireframe diagrams — original vector illustrations
- blueprint: compose
- rules: waterfall-entry, svg-path-draw, spring-pop-entrance
- sfx: none

Scene 1 (0–3s): Enormous left-aligned headline YOUR SERVER. YOUR PLATFORM. lands with waterfall-entry. A single app wireframe sits right, with a sketched server rack beneath it. Scene 2 (3–7s): Use svg-path-draw to connect the app to a larger Platform control-plane outline. Bring in the real labels Ubuntu server and Kubernetes (k3s) with spring-pop-entrance. Scene 3 (7s–end): Three connected modules Deploy / Connect / Observe assemble, while the headline emphasis shifts coral. The camera stays still; the diagram does the explaining. Keep all body labels at least 28px. Conceptual illustration label at the top. No invented metrics.

Use only the palette and font files in frame.md. Font paths: assets/fonts/SpaceGrotesk.ttf, assets/fonts/JetBrainsMono.ttf, assets/fonts/ArchivoBlack.ttf. Stage logo path assets/logo-light.png. Author unique DOM IDs prefixed by 01-own. Use a full-duration background clip. No audio in the frame.

## Frame 2 — From server to a running application

- scene: From server to a running application
- duration: 15s
- poster: 7s
- transition_in: cut
- status: animated
- src: compositions/frames/02-deploy.html
- voiceover: "Install the CLI, provision your server, and connect your repository. GitOps with Argo CD keeps your application manifests in sync with the cluster."
- asset_candidates: logo-light.png
- focal: From server to a running application
- roles: logo-light.png — supporting brand lockup; wireframe diagrams — original vector illustrations
- blueprint: compose
- rules: waterfall-entry, svg-path-draw, spring-pop-entrance
- sfx: none

Scene 1 (0–3s): Left title FROM SERVER TO APP and a large warm-ink terminal using the installed terminal-simulator component as the starting primitive. Show sudo platformctl provision as the primary real command with waterfall-entry. Scene 2 (3–7s): A Git repo wireframe and an Argo CD node connect through svg-path-draw as the repository is connected. Scene 3 (7s–end): The application arrives in its Kubernetes cluster boundary with spring-pop-entrance, ending on GIT → ARGO CD → YOUR APP. Illustration only: do not fabricate a real screenshot, build output, or timing claim.

Use only the palette and font files in frame.md. Font paths: assets/fonts/SpaceGrotesk.ttf, assets/fonts/JetBrainsMono.ttf, assets/fonts/ArchivoBlack.ttf. Stage logo path assets/logo-light.png. Author unique DOM IDs prefixed by 02-deploy. Use a full-duration background clip. No audio in the frame.

## Frame 3 — One place to operate the application

- scene: One place to operate the application
- duration: 15s
- poster: 7s
- transition_in: cut
- status: animated
- src: compositions/frames/03-operate.html
- voiceover: "Bring your app's data and operations together. Provision PostgreSQL, MongoDB, and Redis. Manage encrypted secrets, inspect logs, and follow application metrics from the dashboard."
- asset_candidates: logo-light.png
- focal: One place to operate the application
- roles: logo-light.png — supporting brand lockup; wireframe diagrams — original vector illustrations
- blueprint: compose
- rules: waterfall-entry, svg-path-draw, spring-pop-entrance
- sfx: none

Scene 1 (0–3s): Title THE APP IS JUST THE START. Oversized application wireframe with an orders-api label. Scene 2 (3–7s): PostgreSQL, MongoDB, Redis connect around it via svg-path-draw; separate the data plane spatially from the operations panel. Scene 3 (7s–end): Stagger-reveal the operations strip Encrypted secrets / Logs / Metrics, and highlight one at a time. All panels are schematic: use label rows and blocks, no made-up charts or telemetry numbers. Conclude on ONE OPERATIONS WORKFLOW. Use spring-pop-entrance for the shared control surface.

Use only the palette and font files in frame.md. Font paths: assets/fonts/SpaceGrotesk.ttf, assets/fonts/JetBrainsMono.ttf, assets/fonts/ArchivoBlack.ttf. Stage logo path assets/logo-light.png. Author unique DOM IDs prefixed by 03-operate. Use a full-duration background clip. No audio in the frame.

## Frame 4 — Agent access with human control

- scene: Agent access with human control
- duration: 15s
- poster: 7s
- transition_in: cut
- status: animated
- src: compositions/frames/04-control.html
- voiceover: "Connect your AI tools through MCP with scoped agent tokens. Commands are validated, and destructive actions need human approval. Your server. Your apps. Start with the docs."
- asset_candidates: logo-light.png
- focal: Agent access with human control
- roles: logo-light.png — supporting brand lockup; wireframe diagrams — original vector illustrations
- blueprint: compose
- rules: waterfall-entry, svg-path-draw, spring-pop-entrance
- sfx: none

Scene 1 (0–3s): Title ASK YOUR AGENT. KEEP THE CONTROLS. A node labeled MCP client connects to Platform tools, with Scoped token on the connector. Scene 2 (3–7s): svg-path-draw moves the command into a visible Command guard box; a Human approval gate appears for destructive actions. Scene 3 (7s–end): Simplify to the real logo and a giant YOUR SERVER. YOUR APPS. close. CTA platform.pratyushes.dev/docs appears with waterfall-entry. All claims trace to docs/mcp/overview.md. Keep the CTA and logo inside the frame with generous clearance.

Use only the palette and font files in frame.md. Font paths: assets/fonts/SpaceGrotesk.ttf, assets/fonts/JetBrainsMono.ttf, assets/fonts/ArchivoBlack.ttf. Stage logo path assets/logo-light.png. Author unique DOM IDs prefixed by 04-control. Use a full-duration background clip. No audio in the frame.

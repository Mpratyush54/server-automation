// A terminal pane for the recordings: xterm.js in a recorded browser page.
//
// Two ways to fill it, both with real output and real timing:
//   replay(cast)  - an asciinema recording made on the server (the install),
//                   after secrets are masked and long pauses shortened;
//   run(command)  - a command run now by the recording machine (a curl loop,
//                   ssh to a server, an MCP client), streamed as it prints.
// The prompt and command line are typed at a human pace before running.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { typingDelay } from './config.mjs';

const require = createRequire(import.meta.url);
const xtermJs = await readFile(require.resolve('@xterm/xterm/lib/xterm.js'), 'utf8');
const xtermCss = await readFile(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8');

// Signal palette: graphite background, amber accent, status colours.
const THEME = {
  background: '#16181B', foreground: '#E6E7E9', cursor: '#F2B53A', selectionBackground: '#3A3F45',
  black: '#16181B', red: '#E5484D', green: '#3FB37F', yellow: '#E0A100', blue: '#6EA8FE', magenta: '#C792EA', cyan: '#5CCFE6', white: '#E6E7E9',
  brightBlack: '#7D838B', brightRed: '#FF6369', brightGreen: '#4CC38A', brightYellow: '#F2B53A', brightBlue: '#8AB4F8', brightMagenta: '#D7A8F5', brightCyan: '#7FDBEF', brightWhite: '#FFFFFF',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Terminal {
  /** Turn a recorded page into a terminal. `title` shows in a quiet bar above it. */
  static async open(page, { title = '', fontSize = 15, cols, rows } = {}) {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${xtermCss}
      html, body { margin: 0; height: 100%; background: ${THEME.background}; }
      body { display: flex; flex-direction: column; font-family: 'IBM Plex Sans', system-ui, sans-serif; }
      .bar { flex: none; padding: 10px 18px; color: #9AA0A6; font-size: 13px; border-bottom: 1px solid #2A2E33; }
      #term { flex: 1; padding: 14px 18px; min-height: 0; }
    </style></head><body>${title ? `<div class="bar">${title.replace(/</g, '&lt;')}</div>` : ''}<div id="term"></div>
    <script>${xtermJs}</script></body></html>`);
    await page.evaluate(({ theme, fontSize, cols, rows }) => {
      const host = document.getElementById('term');
      const term = new window.Terminal({
        theme, fontSize, cursorBlink: false, convertEol: true, scrollback: 2000,
        fontFamily: "'IBM Plex Mono', 'JetBrains Mono', 'DejaVu Sans Mono', monospace",
      });
      term.open(host);
      // Fit to the pane: measure one cell, then size the grid.
      const cell = term._core._renderService.dimensions.css.cell;
      // clientWidth/Height include the host's padding; size the grid to the content box.
      const style = getComputedStyle(host);
      const width = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      term.resize(cols ?? Math.floor(width / cell.width), rows ?? Math.floor(height / cell.height));
      window.__term = term;
    }, { theme: THEME, fontSize, cols, rows });
    return new Terminal(page);
  }

  constructor(page) {
    this.page = page;
  }

  write(data) {
    return this.page.evaluate((chunk) => new Promise((resolve) => window.__term.write(chunk, resolve)), data);
  }

  size() {
    return this.page.evaluate(() => ({ cols: window.__term.cols, rows: window.__term.rows }));
  }

  /** Show a prompt and type a command line at a human pace (display only). */
  async typeCommand(command, { prompt = '\x1b[38;2;242;181;58m$\x1b[0m ' } = {}) {
    await this.write(prompt);
    const delay = typingDelay();
    for (const char of command) {
      await this.write(char);
      await sleep(delay * (0.6 + Math.random() * 0.8));
    }
    await sleep(350);
    await this.write('\r\n');
  }

  /**
   * Replay an asciicast with its own timing. `onTime(t)` is called with the
   * cast time of each event, so the clip script can set marks.
   */
  async replay(cast, { onTime } = {}) {
    const start = performance.now();
    for (const event of cast.events) {
      if (event.type !== 'o') continue;
      const due = start + event.time * 1000;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
      await this.write(event.data);
      onTime?.(event.time);
    }
  }

  /**
   * Type a command, run it on this machine and stream its output into the
   * pane. `argv` is what really runs; `shown` is the line typed on screen
   * (for example without an env file path). Resolves with the exit code, or
   * when `until(output)` returns true (the process is then stopped).
   */
  async run(argv, { shown = argv.join(' '), env = process.env, until, input } = {}) {
    await this.typeCommand(shown);
    // detached: its own process group, so stop() also ends what a shell started.
    const child = spawn(argv[0], argv.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.child = child;
    let output = '';
    let settle;
    const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    let writing = Promise.resolve();
    let failed = false;
    const stop = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch { /* already gone */ }
    };
    const onData = (text) => {
      output += text;
      writing = writing.then(() => this.write(text)).catch((error) => {
        if (!failed) { failed = true; stop(); settle.reject(error); }
      });
      if (until?.(output)) stop();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => { /* the process ended before reading all its input */ });
    child.on('close', (code) => writing.then(() => settle.resolve({ code, output })));
    child.on('error', (error) => settle.resolve({ code: -1, output: output + String(error) }));
    if (input !== undefined) child.stdin.end(input);
    /** Stop the process and wait until its last output is on screen. */
    const finish = async () => {
      stop();
      return done;
    };
    return { child, done, finish, output: () => output };
  }
}

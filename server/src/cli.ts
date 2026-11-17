import chalk from 'chalk';
import readline from 'readline/promises';
import crypto from 'crypto';
import path from 'node:path';
import os from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import boxen from 'boxen';
import gradient from 'gradient-string';

const SESSION_ID = crypto.randomUUID();
const API_BASE = process.env.API_BASE || 'http://localhost:5000/api/documents';
const TENANT_ID = process.env.TENANT_ID || 'tenant_default_123';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const brandGradient = gradient(['#D97757', '#E89B74', '#F4C095']);
const claudeOrange = chalk.hex('#D97757');

const ENDPOINT_LABEL = (() => {
  try {
    return new URL(API_BASE).host;
  } catch {
    return API_BASE;
  }
})();

// Claude Code's signature rotating star frames
const CLAUDE_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

class ClaudeIndicator {
  private timer: NodeJS.Timeout | null = null;
  private frameIdx = 0;
  private startTime = performance.now();
  private state: 'thinking' | 'streaming' | 'idle' = 'idle';

  startThinking() {
    this.state = 'thinking';
    this.startTime = performance.now();
    this.frameIdx = 0;

    // Hide cursor during animation
    process.stdout.write('\x1b[?25l\n');

    this.timer = setInterval(() => {
      const frame = CLAUDE_FRAMES[this.frameIdx % CLAUDE_FRAMES.length];
      const elapsed = ((performance.now() - this.startTime) / 1000).toFixed(1);
      this.frameIdx++;

      // Clear current line and render pulsing Claude star + timer
      process.stdout.write(
        `\r\x1b[2K${claudeOrange.bold(frame)} ${chalk.dim(`Thinking... (${elapsed}s)`)}`
      );
    }, 90);
  }

  switchToStreaming() {
    if (this.timer) clearInterval(this.timer);
    this.state = 'streaming';

    // Replace "Thinking..." line with the header, and remember the icon's exact coordinate
    // \x1b7 saves cursor position, \x1b8 restores cursor position
    process.stdout.write(`\r\x1b[2K\x1b7${claudeOrange.bold('✳')} ${brandGradient('Assistant')}\n`);

    // Keep the icon pulsing at the top of the message while tokens stream below!
    this.timer = setInterval(() => {
      const frame = CLAUDE_FRAMES[this.frameIdx % CLAUDE_FRAMES.length];
      this.frameIdx++;

      // Save current text cursor -> jump to icon -> redraw frame -> jump back to text
      process.stdout.write(`\x1b[s\x1b8${claudeOrange.bold(frame)}\x1b[u`);
    }, 110);
  }

  stop(success = true) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const finalIcon = success ? claudeOrange.bold('⏺') : chalk.red.bold('✖');

    if (this.state === 'streaming') {
      // Lock the pulsing icon into a solid Claude dot
      process.stdout.write(`\x1b[s\x1b8${finalIcon}\x1b[u`);
    } else if (this.state === 'thinking') {
      process.stdout.write(`\r\x1b[2K${finalIcon} ${chalk.red('Request failed')}\n`);
    }

    // Show cursor again
    process.stdout.write('\x1b[?25h');
    this.state = 'idle';
  }
}

/**
 * A one-line spinner for non-streaming work (upload, list). It reuses the
 * same visual language as the chat indicator so the CLI feels consistent.
 */
const withSpinner = async <T>(label: string, task: () => Promise<T>): Promise<T> => {
  let frameIdx = 0;
  const startedAt = performance.now();

  const render = () => {
    const frame = CLAUDE_FRAMES[frameIdx % CLAUDE_FRAMES.length];
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
    frameIdx++;
    process.stdout.write(`\r\x1b[2K${claudeOrange.bold(frame)} ${chalk.dim(`${label} (${elapsed}s)`)}`);
  };

  process.stdout.write('\x1b[?25l');
  render();
  const timer = setInterval(render, 90);

  try {
    return await task();
  } finally {
    clearInterval(timer);
    process.stdout.write('\r\x1b[2K\x1b[?25h');
  }
};

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
};

const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)}s`;
};

const formatNumber = (value: number): string =>
  Number.isFinite(value) ? value.toLocaleString('en-US') : '—';

const stripQuotes = (value: string): string =>
  value.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');

const expandHome = (value: string): string => {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
};

interface ModuleSummary {
  sourceHash: string;
  sourceFile: string;
  chunks: number;
  tokens: number;
  pages?: number | null;
  ingestedAt?: string;
}

interface UploadResponse {
  message?: string;
  fileName?: string;
  tenantId?: string;
  totalPages?: number;
  durationMs?: number;
  sourceHash?: string;
  totalChunks?: number;
  insertedCount?: number;
  duplicateCount?: number;
  skipped?: boolean;
  writeErrors?: unknown[];
  error?: string;
}

const readJsonBody = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { error: text } as T;
  }
};

const uploadModule = async (rawPath: string): Promise<void> => {
  const filePath = path.resolve(expandHome(stripQuotes(rawPath)));

  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    console.log(chalk.red(`\n✖ File not found: ${chalk.underline(filePath)}\n`));
    return;
  }

  if (!fileStats.isFile()) {
    console.log(chalk.red(`\n✖ That path is not a file: ${filePath}\n`));
    return;
  }

  if (path.extname(filePath).toLowerCase() !== '.pdf') {
    console.log(chalk.red(`\n✖ Only PDF modules can be uploaded: ${path.basename(filePath)}\n`));
    return;
  }

  if (fileStats.size > MAX_UPLOAD_BYTES) {
    console.log(
      chalk.red(
        `\n✖ File is ${formatBytes(fileStats.size)}, the server limit is ${formatBytes(MAX_UPLOAD_BYTES)}.\n`
      )
    );
    return;
  }

  if (fileStats.size === 0) {
    console.log(chalk.red(`\n✖ File is empty: ${path.basename(filePath)}\n`));
    return;
  }

  const fileName = path.basename(filePath);

  let payload: UploadResponse;
  try {
    const buffer = await readFile(filePath);
    const form = new FormData();
    form.append(
      'document',
      new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }),
      fileName
    );
    form.append('tenantId', TENANT_ID);

    payload = await withSpinner(
      `Uploading ${fileName} (${formatBytes(fileStats.size)})`,
      async () => {
        const response = await fetch(`${API_BASE}/upload`, {
          method: 'POST',
          body: form,
        });
        const body = await readJsonBody<UploadResponse>(response);

        if (!response.ok) {
          throw new Error(body.error || `Server responded with ${response.status}`);
        }
        return body;
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`\n✖ Upload failed: ${message}\n`));
    return;
  }

  if (payload.skipped) {
    console.log(
      `${chalk.yellow('↺')} ${chalk.bold(fileName)} is already ingested ${chalk.dim(
        `(${formatNumber(payload.totalChunks ?? 0)} chunks, no duplicates created)`
      )}`
    );
    console.log(chalk.dim('  Ask a question about it, or use /modules to see what is available.\n'));
    return;
  }

  const inserted = payload.insertedCount ?? 0;
  const duplicates = payload.duplicateCount ?? 0;
  const failed = payload.writeErrors?.length ?? 0;
  const failedSuffix = failed > 0 ? chalk.red(` · ${failed} failed`) : '';

  console.log(
    `${chalk.green('✔')} ${chalk.bold(fileName)} ${chalk.dim('ingested')}\n` +
      `  ${chalk.dim('Pages')}     ${formatNumber(payload.totalPages ?? 0)}\n` +
      `  ${chalk.dim('Chunks')}    ${formatNumber(inserted)} inserted · ${formatNumber(
        duplicates
      )} duplicates${failedSuffix}\n` +
      `  ${chalk.dim('Duration')}  ${formatDuration(payload.durationMs ?? 0)}\n`
  );
  console.log(
    chalk.dim('  Ready to study. Ask a question, or use /modules to check the library.\n')
  );
};

const listModules = async (): Promise<void> => {
  let payload: { count?: number; documents?: ModuleSummary[]; error?: string };
  try {
    payload = await withSpinner('Loading modules', async () => {
      const response = await fetch(
        `${API_BASE}?tenantId=${encodeURIComponent(TENANT_ID)}`
      );
      const body = await readJsonBody<{
        count?: number;
        documents?: ModuleSummary[];
        error?: string;
      }>(response);

      if (!response.ok) {
        throw new Error(body.error || `Server responded with ${response.status}`);
      }
      return body;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`\n✖ Could not load modules: ${message}\n`));
    return;
  }

  const modules = payload.documents ?? [];
  if (modules.length === 0) {
    console.log(
      `${chalk.dim('No modules ingested yet.')} Use ${chalk.yellow(
        '/upload <path-to-pdf>'
      )} to add one.\n`
    );
    return;
  }

  const trim = (value: string, width: number): string =>
    value.length <= width ? value : `…${value.slice(value.length - (width - 1))}`;

  const rows = modules.map((doc, index) => ({
    index: String(index + 1),
    module: trim(doc.sourceFile, 34),
    chunks: formatNumber(doc.chunks),
    pages: doc.pages ? formatNumber(doc.pages) : '—',
    tokens: formatNumber(doc.tokens),
    ingested: doc.ingestedAt
      ? new Date(doc.ingestedAt).toLocaleString('en-GB', {
          dateStyle: 'short',
          timeStyle: 'short',
        })
      : '—',
  }));

  const width = (key: keyof (typeof rows)[number], header: string): number =>
    Math.max(header.length, ...rows.map((row) => row[key].length));

  const widths = {
    index: width('index', '#'),
    module: width('module', 'Module'),
    chunks: width('chunks', 'Chunks'),
    pages: width('pages', 'Pages'),
    tokens: width('tokens', 'Tokens'),
    ingested: width('ingested', 'Ingested'),
  };

  const pad = (value: string, size: number): string => value.padEnd(size);
  const padLeft = (value: string, size: number): string => value.padStart(size);

  const header =
    `${pad('#', widths.index)}  ${pad('Module', widths.module)}  ` +
    `${padLeft('Chunks', widths.chunks)}  ${padLeft('Pages', widths.pages)}  ` +
    `${padLeft('Tokens', widths.tokens)}  ${pad('Ingested', widths.ingested)}`;

  const lines = rows.map(
    (row) =>
      `${pad(row.index, widths.index)}  ${pad(row.module, widths.module)}  ` +
      `${padLeft(row.chunks, widths.chunks)}  ${padLeft(row.pages, widths.pages)}  ` +
      `${padLeft(row.tokens, widths.tokens)}  ${pad(row.ingested, widths.ingested)}`
  );

  console.log(
    [
      chalk.bold(`${modules.length} module${modules.length === 1 ? '' : 's'} in the library`),
      '',
      chalk.dim(header),
      ...lines,
      '',
      chalk.dim(`Tenant: ${TENANT_ID}`),
      '',
    ].join('\n')
  );
};

const showHelp = () => {
  const lines = [
    `${chalk.yellow('/upload <path>')} ${chalk.dim('— ingest a PDF module (omit path to be prompted)')}`,
    `${chalk.yellow('/modules')} ${chalk.dim('— list ingested modules')} ${chalk.gray('(alias: /docs)')}`,
    `${chalk.yellow('/new')} ${chalk.dim('— start a fresh conversation')}`,
    `${chalk.yellow('/clear')} ${chalk.dim('— clear the terminal (session is kept)')}`,
    `${chalk.yellow('/help')} ${chalk.dim('— show this help')}`,
    `${chalk.yellow('exit')} ${chalk.dim('— quit')}`,
    '',
    chalk.dim('Anything else is sent to the RAG assistant as a question.'),
  ];

  console.log(
    boxen(lines.join('\n'), {
      title: chalk.bold('Commands'),
      titleAlignment: 'left',
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      margin: { top: 0, bottom: 1, left: 0, right: 0 },
      borderStyle: 'round',
      borderColor: '#D97757',
    })
  );
};

const renderBanner = () => {
  console.clear();
  const title = brandGradient.multiline(
    [
      '  ██████╗  █████╗  ██████╗      ██████╗██╗     ██╗',
      '  ██╔══██╗██╔══██╗██╔════╝     ██╔════╝██║     ██║',
      '  ██████╔╝███████║██║  ███╗    ██║     ██║     ██║',
      '  ██╔══██╗██╔══██║██║   ██║    ██║     ██║     ██║',
      '  ██║  ██║██║  ██║╚██████╔╝    ╚██████╗███████╗██║',
      '  ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝      ╚═════╝╚══════╝╚═╝',
    ].join('\n')
  );

  const subtitle = [
    `${chalk.bold.white('RAG Study Assistant')} ${chalk.dim('• Phase 2')}`,
    `${chalk.dim('Session:')} ${chalk.cyan(SESSION_ID.substring(0, 8))}   ${chalk.dim('Endpoint:')} ${chalk.gray(ENDPOINT_LABEL)}`,
    '',
    `${chalk.dim('Study:')}  ${chalk.yellow('/upload')} ${chalk.dim('PDF')}  ${chalk.yellow('/modules')} ${chalk.dim('library')}`,
    `${chalk.dim('Session:')} ${chalk.yellow('/new')}  ${chalk.yellow('/clear')}  ${chalk.yellow('/help')}  ${chalk.yellow('exit')}`,
  ].join('\n');

  console.log(
    boxen(`${title}\n\n${subtitle}`, {
      padding: { top: 1, bottom: 1, left: 2, right: 2 },
      margin: { top: 1, bottom: 1, left: 0, right: 0 },
      borderStyle: 'round',
      borderColor: '#D97757',
    })
  );
};

const askQuestion = async (query: string, currentSessionId: string) => {
  const indicator = new ClaudeIndicator();
  indicator.startThinking();

  const startTime = performance.now();
  let isFirstToken = true;
  let buffer = '';

  try {
    const response = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, sessionId: currentSessionId, tenantId: TENANT_ID }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Server responded with ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const event of events) {
        if (!event.startsWith('data: ')) continue;

        const dataStr = event.replace(/^data:\s*/, '').trim();
        if (dataStr === '[DONE]') continue;

        try {
          const data = JSON.parse(dataStr);

          if (data.token) {
            if (isFirstToken) {
              indicator.switchToStreaming();
              isFirstToken = false;
            }

            if (data.type === 'escalation') {
              process.stdout.write(chalk.yellow(data.token));
            } else {
              process.stdout.write(chalk.white(data.token));
            }
          } else if (data.error) {
            indicator.stop(false);
            console.log(chalk.red(`\n✖ ${data.error}`));
            return;
          }
        } catch {
          // Ignore partial JSON frames
        }
      }
    }

    indicator.stop(true);
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
    console.log(`\n\n${chalk.dim(`─ Completed in ${elapsed}s ─`)}\n`);
  } catch (error) {
    indicator.stop(false);
    console.log(
      boxen(
        `${chalk.red.bold('Could not reach the RAG server')}\n${chalk.dim('Ensure your backend is running at')} ${chalk.underline(API_BASE)}`,
        {
          padding: { top: 0, bottom: 0, left: 1, right: 1 },
          borderStyle: 'round',
          borderColor: 'red',
        }
      )
    );
  }
};

const startCLI = async () => {
  let activeSession = SESSION_ID;
  renderBanner();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // With a TTY, question() only rejects if the interface is already closed.
  // With piped input (scripts, tests) readline closes at EOF, so turn that
  // into a clean exit instead of an ERR_USE_AFTER_CLOSE crash.
  const askLine = async (prompt: string): Promise<string | null> => {
    try {
      return await rl.question(prompt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ERR_USE_AFTER_CLOSE') {
        return null;
      }
      throw error;
    }
  };

  rl.on('SIGINT', () => {
    process.stdout.write('\x1b[?25h'); // Always restore cursor on exit
    console.log(chalk.dim('\n\nSession ended. Goodbye!\n'));
    process.exit(0);
  });

  while (true) {
    const promptPrefix = `${claudeOrange.bold('❯')} ${chalk.bold('You')} ${chalk.dim('›')} `;
    const line = await askLine(promptPrefix);

    if (line === null) {
      rl.close();
      break;
    }

    const answer = line.trim();
    if (!answer) continue;

    const command = answer.toLowerCase();

    if (command === 'exit' || command === '/exit') {
      console.log(chalk.dim('\nGoodbye! 👋\n'));
      rl.close();
      break;
    }

    if (command === '/clear') {
      renderBanner();
      continue;
    }

    if (command === '/help' || command === '/?') {
      showHelp();
      continue;
    }

    if (command === '/new') {
      activeSession = crypto.randomUUID();
      console.log(
        chalk.cyan(`\n↻ Started new session: ${chalk.bold(activeSession.substring(0, 8))}\n`)
      );
      continue;
    }

    if (command === '/modules' || command === '/docs') {
      await listModules();
      continue;
    }

    const uploadMatch = answer.match(/^\/upload(?:\s+([\s\S]+))?$/i);
    if (uploadMatch) {
      let target = uploadMatch[1]?.trim();

      if (!target) {
        const prompted = await askLine(chalk.dim('PDF path › '));
        if (prompted === null) {
          rl.close();
          break;
        }
        target = prompted.trim();
      }

      if (!target) {
        console.log(chalk.dim('\nNo path provided.\n'));
        continue;
      }

      await uploadModule(target);
      continue;
    }

    if (answer.startsWith('/')) {
      console.log(
        `${chalk.yellow('Unknown command.')} Try ${chalk.yellow('/help')} to see what is available.\n`
      );
      continue;
    }

    await askQuestion(answer, activeSession);
  }
};

startCLI();

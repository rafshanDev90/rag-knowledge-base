import chalk from 'chalk';
import readline from 'readline/promises';
import crypto from 'crypto';
import boxen from 'boxen';
import gradient from 'gradient-string';

const SESSION_ID = crypto.randomUUID();
const API_URL = 'http://localhost:5000/api/documents/chat';

const brandGradient = gradient(['#D97757', '#E89B74', '#F4C095']);
const claudeOrange = chalk.hex('#D97757');

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
    `${chalk.bold.white('RAG Document Assistant')} ${chalk.dim('• Phase 2')}`,
    `${chalk.dim('Session:')} ${chalk.cyan(SESSION_ID.substring(0, 8))}   ${chalk.dim('Endpoint:')} ${chalk.gray('localhost:5000')}`,
    '',
    `${chalk.dim('Commands:')} ${chalk.yellow('/clear')} ${chalk.dim('reset')}  ${chalk.yellow('/new')} ${chalk.dim('new session')}  ${chalk.yellow('exit')} ${chalk.dim('quit')}`,
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
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, sessionId: currentSessionId }),
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
        `${chalk.red.bold('Could not reach the RAG server')}\n${chalk.dim('Ensure your backend is running at')} ${chalk.underline(API_URL)}`,
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

  rl.on('SIGINT', () => {
    process.stdout.write('\x1b[?25h'); // Always restore cursor on exit
    console.log(chalk.dim('\n\nSession ended. Goodbye!\n'));
    process.exit(0);
  });

  while (true) {
    const promptPrefix = `${claudeOrange.bold('❯')} ${chalk.bold('You')} ${chalk.dim('›')} `;
    const answer = (await rl.question(promptPrefix)).trim();

    if (!answer) continue;

    if (answer.toLowerCase() === 'exit' || answer.toLowerCase() === '/exit') {
      console.log(chalk.dim('\nGoodbye! 👋\n'));
      rl.close();
      break;
    }

    if (answer.toLowerCase() === '/clear') {
      renderBanner();
      continue;
    }

    if (answer.toLowerCase() === '/new') {
      activeSession = crypto.randomUUID();
      console.log(
        chalk.cyan(`\n↻ Started new session: ${chalk.bold(activeSession.substring(0, 8))}\n`)
      );
      continue;
    }

    await askQuestion(answer, activeSession);
  }
};

startCLI();

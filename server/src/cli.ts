import chalk from 'chalk';
import readline from 'readline';
import crypto from 'crypto';

// Generate ONE session ID for this entire CLI run
const SESSION_ID = crypto.randomUUID();

const askQuestion = async (query: string) => {
  console.log(chalk.blue(`\n🤖 Thinking (Session: ${SESSION_ID.substring(0, 8)}...)...`));
  
  try {
    const response = await fetch('http://localhost:5000/api/documents/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Send the sessionId with every request!
      body: JSON.stringify({ query, sessionId: SESSION_ID }),
    });

    if (!response.body) throw new Error('No response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    process.stdout.write(chalk.green(`\nAnswer: `));

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.replace('data: ', '').trim();
          if (dataStr === '[DONE]') continue;

          try {
            const data = JSON.parse(dataStr);
            if (data.token) {
              // If it's an escalation, print it in yellow to stand out
              if (data.type === 'escalation') {
                process.stdout.write(chalk.yellow(data.token));
              } else {
                process.stdout.write(chalk.green(data.token));
              }
            } else if (data.error) {
              console.log(chalk.red(`\nError: ${data.error}`));
            }
          } catch (e) {
            // Ignore partial JSON
          }
        }
      }
    }
    console.log('\n');
  } catch (error) {
    console.error(chalk.red('\nFailed to connect to the server. Is it running?'));
  }
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log(chalk.cyan.bold('========================================'));
console.log(chalk.cyan.bold('   📚 RAG Assistant CLI (Phase 2)       '));
console.log(chalk.cyan.bold('========================================'));
console.log(chalk.gray(`Session ID: ${SESSION_ID}`));
console.log(chalk.gray('Type your question and press Enter. (Type "exit" to quit)'));

const promptUser = () => {
  rl.question(chalk.yellow('\nYou: '), async (answer) => {
    if (answer.toLowerCase() === 'exit') {
      rl.close();
      return;
    }
    
    await askQuestion(answer);
    promptUser(); 
  });
};

promptUser();
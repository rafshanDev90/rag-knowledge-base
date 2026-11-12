import chalk from 'chalk';
import readline from 'readline';

// We use native Node.js fetch (available in Node 18+)
const askQuestion = async (query: string) => {
  console.log(chalk.blue(`\n🤖 Thinking...`));
  
  try {
    const response = await fetch('http://localhost:5000/api/documents/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    if (!response.body) throw new Error('No response body');

    // Read the stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    process.stdout.write(chalk.green(`\nAnswer: `));

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      // Split by SSE newlines
      const lines = chunk.split('\n\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.replace('data: ', '').trim();
          if (dataStr === '[DONE]') continue;

          try {
            const data = JSON.parse(dataStr);
            if (data.token) {
              process.stdout.write(chalk.green(data.token));
            } else if (data.error) {
              console.log(chalk.red(`\nError: ${data.error}`));
            }
          } catch (e) {
            // Ignore partial JSON parsing errors during streaming
          }
        }
      }
    }
    console.log('\n');
  } catch (error) {
    console.error(chalk.red('\nFailed to connect to the server. Is it running?'));
  }
};

// Set up the interactive prompt
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log(chalk.cyan.bold('========================================'));
console.log(chalk.cyan.bold('   📚 RAG Document Assistant CLI '));
console.log(chalk.cyan.bold('========================================'));
console.log(chalk.gray('Type your question and press Enter. (Type "exit" to quit)'));

const promptUser = () => {
  rl.question(chalk.yellow('\nYou: '), async (answer) => {
    if (answer.toLowerCase() === 'exit') {
      rl.close();
      return;
    }
    
    await askQuestion(answer);
    promptUser(); // Loop back for the next question
  });
};

promptUser();
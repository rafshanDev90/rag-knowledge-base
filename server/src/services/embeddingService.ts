import { Ollama } from 'ollama';

const ollama = new Ollama({ host: 'http://127.0.0.1:11434' });

export const generateEmbeddings = async (texts: string[]): Promise<number[][]> => {
  try {
    // Ollama's /api/embed endpoint accepts a batch of strings
    const response = await ollama.embed({
      model: 'nomic-embed-text',
      input: texts,
    });

    // The response contains an 'embeddings' array of arrays
    return response.embeddings;
  } catch (error) {
    console.error('Ollama Embedding Error:', error);
    throw new Error('Failed to generate embeddings via Ollama');
  }
};
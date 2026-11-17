import '../config/env.js';
import { Ollama } from 'ollama';

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
});

const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ollama can close the socket while it is loading/restarting a model
 * (for example after an OOM kill). Those failures are worth retrying;
 * a "model not found" or a validation error is not.
 */
const isRetryable = (error: any): boolean => {
  const code = error?.cause?.code || error?.code;
  if (['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(code)) {
    return true;
  }
  return /fetch failed|socket|terminated|loading model|connection/i.test(String(error?.message ?? ''));
};

export const generateEmbeddings = async (texts: string[]): Promise<number[][]> => {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ollama.embed({
        model: EMBED_MODEL,
        input: texts,
        keep_alive: KEEP_ALIVE,
      });

      if (!response.embeddings || response.embeddings.length !== texts.length) {
        throw new Error(
          `Embedding count mismatch: expected ${texts.length}, got ${response.embeddings?.length ?? 0}`
        );
      }

      return response.embeddings;
    } catch (error) {
      lastError = error;
      console.error(
        `Ollama Embedding Error (attempt ${attempt}/${MAX_ATTEMPTS}):`,
        error
      );

      if (attempt === MAX_ATTEMPTS || !isRetryable(error)) break;

      // Exponential backoff with jitter: ~500ms, ~1s.
      await sleep(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    }
  }

  const cause = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Failed to generate embeddings via Ollama: ${cause}`);
};

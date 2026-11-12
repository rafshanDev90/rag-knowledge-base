import { Request, Response } from 'express';
import { DocumentChunk } from '../models/DocumentChunk.js';
import { generateEmbeddings } from '../services/embeddingService.js';
import { Ollama } from 'ollama';

const ollama = new Ollama({ host: 'http://127.0.0.1:11434' });

export const chatWithDocument = async (req: Request, res: Response): Promise<void> => {
  try {
    const { query, tenantId = 'tenant_default_123' } = req.body;

    if (!query) {
      res.status(400).json({ error: 'Query is required.' });
      return;
    }

    // 1. Embed the user's question
    const queryEmbedding = (await generateEmbeddings([query]))[0];

    // 2. Retrieve the top 3 most relevant chunks from MongoDB
    const results = await DocumentChunk.aggregate([
      {
        $vectorSearch: {
          index: 'vector_index',
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: 100,
          limit: 3,
          filter: { tenantId: tenantId }, // Keep tenant isolation
        },
      },
      {
        $project: { text: 1, sourceFile: 1, chunkIndex: 1 },
      },
    ]);

    if (results.length === 0) {
      res.status(404).json({ error: 'No relevant context found for this query.' });
      return;
    }

    // 3. Build the Context Block
    const context = results
      .map((r: any) => `[Source: ${r.sourceFile}, Chunk ${r.chunkIndex}]\n${r.text}`)
      .join('\n\n');

    // 4. Construct the Prompt (The "Injection" phase)
    const systemPrompt = `You are a helpful assistant. Answer the user's question using ONLY the provided context below. If the answer is not in the context, say "I don't know based on the provided documents."

CONTEXT:
${context}`;

    // 5. Set up SSE Headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // 6. Stream from Ollama
    // Note: If qwen3.5 uses a "thinking" mode by default, you can add `think: false` here to speed up standard RAG responses.
    const stream = await ollama.chat({
      model: 'gemma4:latest',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query },
      ],
      stream: true,
    });

    // 7. Pipe tokens to the client
    for await (const chunk of stream) {
      // Ollama sends chunks where message.content is the token
      if (chunk.message.content) {
        res.write(`data: ${JSON.stringify({ token: chunk.message.content })}\n\n`);
      }
    }

    // 8. End the stream cleanly
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error: any) {
    console.error('Chat Error:', error);
    // If headers are already sent, we can't send JSON, just end.
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: 'Failed to generate answer.' });
    }
  }
};
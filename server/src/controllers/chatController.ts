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

    const queryEmbedding = (await generateEmbeddings([query]))[0];

    const results = await DocumentChunk.aggregate([
      {
        $vectorSearch: {
          index: 'vector_index',
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: 100,
          limit: 3,
          filter: { tenantId: tenantId },
        },
      },
      {
        $project: { 
          text: 1, 
          sourceFile: 1, 
          chunkIndex: 1,
          score: { $meta: 'vectorSearchScore' } // Get the score
        },
      },
    ]);

    // UPGRADE 1: Filter out low-quality matches (Score threshold)
    const validResults = results.filter((r: any) => r.score > 0.70);

    if (validResults.length === 0) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ token: "I'm sorry, I couldn't find relevant information in the provided documents to answer that." })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const context = validResults
      .map((r: any) => `[Source: ${r.sourceFile}, Chunk ${r.chunkIndex}]\n${r.text}`)
      .join('\n\n');

    // UPGRADE 2: Force the LLM to cite its sources
    const systemPrompt = `You are a helpful technical assistant. Answer the user's question using ONLY the provided context below. 
If the answer is not in the context, say "I don't know based on the provided documents."
When you use information from the context, cite the source in brackets, like [Source: filename, Chunk X].

CONTEXT:
${context}`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await ollama.chat({
      model: 'gemma4:latest',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query },
      ],
      stream: true,
    });

    for await (const chunk of stream) {
      if (chunk.message.content) {
        res.write(`data: ${JSON.stringify({ token: chunk.message.content })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error: any) {
    console.error('Chat Error:', error);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: 'Failed to generate answer.' });
    }
  }
};
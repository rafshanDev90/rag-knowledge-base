import { Request, Response } from 'express';
import crypto from 'crypto'; // NEW: Native crypto for UUID generation

import { DocumentChunk } from '../models/DocumentChunk.js';
import { generateEmbeddings } from '../services/embeddingService.js';
import { getOrCreateSession, getContextForLLM, saveMessage, compactHistory } from '../services/sessionService.js';
import { Ollama } from 'ollama';

const ollama = new Ollama({ host: 'http://127.0.0.1:11434' });

export const chatWithDocument = async (req: Request, res: Response): Promise<void> => {
  try {
    const { query, tenantId = 'tenant_default_123', userId = 'user_123' } = req.body;
    // FIX: Generate a sessionId if the client didn't provide one
    const sessionId = req.body.sessionId || crypto.randomUUID();
    
    if (!query) {
      res.status(400).json({ error: 'Query is required.' });
      return;
    }
    const session = await getOrCreateSession(sessionId, tenantId, userId);
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
    // 4. Get the full conversation history + new query
    const messages = await getContextForLLM(session, query);
    // 5. Prepend the System Prompt
    messages.unshift({ role: 'system', content: systemPrompt });
    // 6. Save the user message to DB
    await saveMessage(sessionId, 'user', query);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await ollama.chat({
      model: 'gemma4:latest',
      messages: messages,
      stream: true,
      keep_alive: '30m', // Keep model loaded for session continuity
    });

    let fullResponse = '';

    for await (const chunk of stream) {
      if (chunk.message.content) {
        fullResponse += chunk.message.content;
        res.write(`data: ${JSON.stringify({ token: chunk.message.content })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();

    // 8. After streaming, save the assistant's response
    await saveMessage(sessionId, 'assistant', fullResponse, validResults);
    // 9. Check if we need to compact the history
    await compactHistory(session);

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
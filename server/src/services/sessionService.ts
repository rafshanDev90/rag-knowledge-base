import { ChatSession, IChatSession } from '../models/ChatSession.js';
import { ChatMessage, IChatMessage } from '../models/ChatMessage.js';

import { generateText } from './llmService.js'; // NEW: Use abstraction layer
import { getEncoding } from 'js-tiktoken';
import { Ollama } from 'ollama';

const enc = getEncoding('cl100k_base');
const ollama = new Ollama({ host: 'http://127.0.0.1:11434' });

const MAX_CONTEXT_TOKENS = 3000; // Budget for history (adjust based on model)
const WINDOW_SIZE = 10;          // Number of recent messages to keep raw

export const getOrCreateSession = async (sessionId: string, tenantId: string, userId: string): Promise<IChatSession> => {
  let session = await ChatSession.findOne({ sessionId });
  if (!session) {
    session = await ChatSession.create({ sessionId, tenantId, userId });
  }
  return session;
};

export const getContextForLLM = async (session: IChatSession, newQuery: string): Promise<any[]> => {
  // 1. Fetch recent messages (Sliding Window)
  const recentMessages = await ChatMessage.find({ sessionId: session.sessionId })
    .sort({ createdAt: -1 })
    .limit(WINDOW_SIZE)
    .lean();

  // Reverse to chronological order
  recentMessages.reverse();

  // 2. Construct the base messages array for Ollama
  const messages: any[] = [];
  
  // Inject the running summary if it exists
  if (session.runningSummary) {
    messages.push({
      role: 'system',
      content: `Summary of previous conversation: ${session.runningSummary}`
    });
  }

  // Add the recent messages
  recentMessages.forEach(msg => {
    messages.push({ role: msg.role, content: msg.content });
  });

  // Add the new user query
  messages.push({ role: 'user', content: newQuery });

  return messages;
};

export const saveMessage = async (sessionId: string, role: 'user' | 'assistant', content: string, sources?: any[]) => {
  await ChatMessage.create({ sessionId, role, content, sources });
  await ChatSession.updateOne({ sessionId }, { $set: { updatedAt: new Date() } });
};

export const compactHistory = async (session: IChatSession) => {
  const totalTokens = session.summaryTokenCount + 
    (await ChatMessage.find({ sessionId: session.sessionId }).lean())
      .reduce((acc, msg) => acc + enc.encode(msg.content).length, 0);

  if (totalTokens > MAX_CONTEXT_TOKENS) {
    // Fetch the oldest messages to summarize (e.g., all but the last WINDOW_SIZE)
    const oldMessages = await ChatMessage.find({ sessionId: session.sessionId })
      .sort({ createdAt: 1 })
      .limit(20) // Fetch a batch to summarize
      .lean();

    if (oldMessages.length === 0) return;

    const textToSummarize = oldMessages.map(m => `${m.role}: ${m.content}`).join('\n');
    
    const prompt = `Summarize the following conversation concisely, preserving key facts and user intent:\n\n${textToSummarize}`;
    const summaryText = await generateText(prompt);

    const newSummary = `${session.runningSummary}\n${summaryText}`.trim();
    
    // Update session with new summary
    await ChatSession.updateOne(
      { sessionId: session.sessionId },
      { 
        $set: { 
          runningSummary: newSummary,
          summaryTokenCount: enc.encode(newSummary).length
        } 
      }
    );

    // Delete the raw messages that have been summarized to save space
    const oldestIds = oldMessages.map(m => m._id);
    await ChatMessage.deleteMany({ _id: { $in: oldestIds } });
  }
};
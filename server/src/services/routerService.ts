import { Ollama } from 'ollama';

const ollama = new Ollama({ host: 'http://127.0.0.1:11434' });

export type Intent = 'DOCUMENT_QA' | 'HIGH_RISK' | 'CHITCHAT';

export const classifyIntent = async (query: string): Promise<{ intent: Intent; reason: string }> => {
  const systemPrompt = `You are a customer service intent router. Classify the user's query into exactly one of these three categories:
  
  1. DOCUMENT_QA: The user is asking a technical question, seeking information, or asking about the provided documents.
  2. HIGH_RISK: The user is asking for a refund, disputing a charge, threatening legal action, or demanding to speak to a human.
  3. CHITCHAT: Greetings, casual conversation, or questions completely unrelated to the documents.

  Respond ONLY with a valid JSON object matching this schema:
  {"intent": "DOCUMENT_QA" | "HIGH_RISK" | "CHITCHAT", "reason": "A short explanation"}`;

  try {
    const response = await ollama.chat({
      model: 'gemma4:latest',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query }
      ],
      stream: false,
      format: 'json', // Senior Trick: Forces Ollama to output valid JSON
    });

    const result = JSON.parse(response.message.content);
    return {
      intent: result.intent as Intent,
      reason: result.reason,
    };
  } catch (error) {
    console.error('Router Error (Falling back to DOCUMENT_QA):', error);
    // Fallback: If the router fails, default to RAG so we don't break the user experience
    return { intent: 'DOCUMENT_QA', reason: 'Router failure fallback' };
  }
};
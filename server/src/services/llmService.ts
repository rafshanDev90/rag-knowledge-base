import {Ollama} from "ollama";

const ollama = new Ollama({ host: 'http://127.0.0.1:11434' });

export const MODELS = {
  CHAT: process.env.CHAT_MODEL || 'gemma4:latest',      // Or 'qwen3.5:4b'
  ROUTER: process.env.ROUTER_MODEL || 'qwen3:8b',     // Fast model for routing
  SUMMARY: process.env.SUMMARY_MODEL || 'deepseek-r1:8b',   // Model for context compaction
  RERANK: process.env.RERANK_MODEL || 'onnx-community/Qwen3-Reranker-0.6B-ONNX',
}

export const streamChat = async (messages: any[]) => {
  return await ollama.chat({
    model: MODELS.CHAT,
    messages: messages,
    stream: true,
    keep_alive: '30m', 
  });
};

export const generateJSON = async (systemPrompt: string, userPrompt: string) => {
  const response = await ollama.chat({
    model: MODELS.ROUTER,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    stream: false,
    format: 'json', // Forces valid JSON output
  });
  return response.message.content;
};

export const generateText = async (prompt: string) => {
  const response = await ollama.generate({
    model: MODELS.SUMMARY,
    prompt: prompt,
    stream: false,
  });
  return response.response;
}
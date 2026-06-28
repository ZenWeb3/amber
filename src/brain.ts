import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY missing from .env');
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_PROMPT = `you are amber, a slack agent that routes questions across tools (github, google drive, calendar, notion, web search) to find answers for a team.

right now your tools aren't wired up yet — you're answering from general knowledge while the integration is being built. acknowledge this when relevant.

style rules:
- be concise. one or two short paragraphs unless the user asks for depth.
- never invent facts. if you don't know, say so plainly.
- when a question is ambiguous, pick the most likely meaning for a software team (e.g. "mcp" means model context protocol in this context, not metacarpophalangeal joints).
- skip preamble. don't say "great question" or "happy to help."
- use plain prose. minimal bullet points. no headings unless the answer is genuinely structured.`;

export class BrainError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'BrainError';
  }
}

async function callGemini(prompt: string): Promise<string> {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.4,
    },
  });
  const text = response.text;
  if (!text || !text.trim()) {
    throw new BrainError('gemini returned empty response');
  }
  return text.trim();
}

function isRetryable(err: any): boolean {
  const msg = err?.message ?? String(err);
  const cause = err?.cause?.code;
  return (
    msg.includes('fetch failed') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ENOTFOUND') ||
    cause === 'ETIMEDOUT' ||
    cause === 'ECONNRESET'
  );
}

export async function think(prompt: string): Promise<string> {
  const maxAttempts = 3;
  let lastErr: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callGemini(prompt);
    } catch (err: any) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts) break;
      const backoffMs = 500 * Math.pow(2, attempt - 1);  // 500, 1000, 2000
      console.log(`gemini attempt ${attempt} failed, retrying in ${backoffMs}ms`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  // unwrap to a useful BrainError
  const msg = lastErr?.message ?? String(lastErr);
  if (msg.includes('API key')) {
    throw new BrainError('gemini api key invalid or missing', lastErr);
  }
  if (msg.includes('quota') || msg.includes('rate')) {
    throw new BrainError('gemini rate limit hit — try again in a moment', lastErr);
  }
  if (msg.includes('safety') || msg.includes('blocked')) {
    throw new BrainError('gemini blocked this request for safety reasons', lastErr);
  }
  if (isRetryable(lastErr)) {
    throw new BrainError('network failed reaching gemini after 3 retries', lastErr);
  }
  throw new BrainError(`gemini failed: ${msg}`, lastErr);
}

if (require.main === module) {
  think('say "amber brain online" and nothing else').then(console.log).catch(console.error);
}
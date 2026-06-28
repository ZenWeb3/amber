import * as dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { GoogleGenAI } from "@google/genai";
import * as dotenv from "dotenv";
import { McpRegistry, RegisteredTool } from "./mcp/registry";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY missing from .env");
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_PROMPT = `you are amber, a slack agent for a software team. you have access to tools (github so far; more coming) and can answer from your own knowledge when no tool fits.

decision rule for each question:
- if the question is about *specific real-time state* (open prs, recent commits, what's in a doc, what's on the calendar, what's trending), use a tool.
- if the question is about *general knowledge, concepts, definitions, or how something works*, answer from your knowledge directly. do not invoke or mention tools.
- if no tool is available for the kind of state being asked about, say so plainly and offer what general knowledge you can. do not invent tool names.

style:
- concise. one or two short paragraphs unless depth is asked for.
- never invent facts. never invent tool names.
- ambiguous acronyms default to the software-team meaning (e.g. "mcp" = model context protocol).
- skip preamble — no "great question" or "happy to help".
- when you do call tools, ground your answer in what they returned.`;

export class BrainError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "BrainError";
  }
}

/**
 * aggressively sanitize an MCP json-schema into something gemini accepts.
 * gemini rejects: $ref, anyOf/oneOf at non-root, mismatched enums, additionalProperties,
 * many format strings, and a few other things. when in doubt we drop the constraint.
 */
function toGeminiSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return { type: "string" };

  if (Array.isArray(schema.anyOf)) return toGeminiSchema(schema.anyOf[0]);
  if (Array.isArray(schema.oneOf)) return toGeminiSchema(schema.oneOf[0]);
  if (Array.isArray(schema.allOf)) return toGeminiSchema(schema.allOf[0]);
  if (schema.$ref) return { type: "string" };

  let type = schema.type;
  if (Array.isArray(type))
    type = type.find((t: any) => t !== "null") || "string";

  const cleaned: any = {};

  if (typeof type === "string") cleaned.type = type;
  else if (schema.properties) cleaned.type = "object";
  else if (schema.items) cleaned.type = "array";
  else cleaned.type = "string";

  if (typeof schema.description === "string") {
    cleaned.description = schema.description.slice(0, 512);
  }

  if (cleaned.type === "object") {
    cleaned.properties = {};
    for (const [k, v] of Object.entries(schema.properties || {})) {
      cleaned.properties[k] = toGeminiSchema(v);
    }
    if (Array.isArray(schema.required) && schema.required.length > 0) {
      const valid = schema.required.filter(
        (r: string) => cleaned.properties[r],
      );
      if (valid.length > 0) cleaned.required = valid;
    }
  }

  if (cleaned.type === "array") {
    cleaned.items = schema.items
      ? toGeminiSchema(schema.items)
      : { type: "string" };
  }

  return cleaned;
}

function toolsToFunctionDeclarations(tools: RegisteredTool[]) {
  const declarations = [];
  for (const t of tools) {
    try {
      declarations.push({
        name: t.qualifiedName,
        description: (t.description || "").slice(0, 1024),
        parameters: toGeminiSchema(t.inputSchema),
      });
    } catch (err) {
      console.warn(
        `[brain] skipping tool ${t.qualifiedName} due to schema error:`,
        err,
      );
    }
  }
  return declarations;
}

export interface ThinkOptions {
  query: string;
  registry?: McpRegistry;
  maxIterations?: number;
  onToolCall?: (name: string, args: any) => void;
}

export interface ToolTrace {
  name: string;
  args: any;
  resultPreview: string;
  durationMs: number;
}

export interface ThinkResult {
  answer: string;
  toolsUsed: ToolTrace[];
}

function isRetryable(err: any): boolean {
  const msg = err?.message ?? String(err);
  const cause = err?.cause?.code;
  return (
    msg.includes("fetch failed") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET") ||
    cause === "ETIMEDOUT" ||
    cause === "ECONNRESET"
  );
}

async function geminiCall(config: any, contents: any[]): Promise<any> {
  const maxAttempts = 3;
  let lastErr: any;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents,
        config,
      });
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === maxAttempts) break;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, i - 1)));
    }
  }
  throw lastErr;
}

export async function think(opts: ThinkOptions): Promise<ThinkResult> {
  const { query, registry, maxIterations = 5, onToolCall } = opts;
  const tools = registry?.getAllTools() ?? [];
  const functionDeclarations =
    tools.length > 0 ? toolsToFunctionDeclarations(tools) : undefined;

  const contents: any[] = [{ role: "user", parts: [{ text: query }] }];
  const toolTraces: ToolTrace[] = [];

  for (let iter = 0; iter < maxIterations; iter++) {
    const config: any = {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.4,
    };
    if (functionDeclarations?.length) {
      config.tools = [{ functionDeclarations }];
    }

    let response;
    try {
      response = await geminiCall(config, contents);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.includes("API key")) {
        throw new BrainError("gemini api key invalid", err);
      }
      if (msg.includes("quota") || msg.includes("rate")) {
        throw new BrainError(
          "gemini rate limit hit — try again in a moment",
          err,
        );
      }
      throw new BrainError(`gemini failed: ${msg}`, err);
    }

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    const functionCalls = parts.filter((p: any) => p.functionCall);
    const textParts = parts.filter((p: any) => p.text);

    if (functionCalls.length > 0 && registry) {
      // record the model's turn
      contents.push({ role: "model", parts });

      // execute each tool call, collect responses
      const responseParts: any[] = [];
      for (const part of functionCalls) {
        const fc = part.functionCall;
        const name = fc.name;
        const args = fc.args || {};
        if (onToolCall) onToolCall(name, args);

        const start = Date.now();
        let result: string;
        try {
          result = await registry.call(name, args);
          if (result.length > 8000)
            result = result.slice(0, 8000) + "\n…[truncated]";
        } catch (err: any) {
          result = `error: ${err?.message ?? String(err)}`;
        }
        const durationMs = Date.now() - start;

        toolTraces.push({
          name,
          args,
          resultPreview: result.slice(0, 200),
          durationMs,
        });

        responseParts.push({
          functionResponse: {
            name,
            response: { result },
          },
        });
      }

      contents.push({ role: "user", parts: responseParts });
      continue;
    }

    // no more tool calls — assemble final answer
    const text = textParts
      .map((p: any) => p.text)
      .join("")
      .trim();
    if (!text) throw new BrainError("gemini returned empty response");
    return { answer: text, toolsUsed: toolTraces };
  }

  throw new BrainError(`hit max ${maxIterations} tool-call iterations`);
}

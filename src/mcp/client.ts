import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: any;
}

export interface McpServerConfig {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * one MCP client = one running MCP server subprocess we can talk to.
 */
export class McpClient {
  readonly id: string;
  private client?: Client;
  private transport?: StdioClientTransport;
  private tools: McpTool[] = [];

  constructor(public config: McpServerConfig) {
    this.id = config.id;
  }

  async start(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: {
        ...(process.env as Record<string, string>),
        ...(this.config.env || {}),
      },
    });

    this.client = new Client(
      { name: `amber-${this.id}`, version: '1.0.0' },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
    const response = await this.client.listTools();
    this.tools = (response.tools || []) as McpTool[];
  }

  getTools(): McpTool[] {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error(`mcp client ${this.id} not started`);
    const result = await this.client.callTool({ name, arguments: args });
    const content = (result.content as any[]) || [];
    return content
      .map((b) => (b.type === 'text' ? b.text : JSON.stringify(b)))
      .join('\n');
  }

  async stop(): Promise<void> {
    try {
      await this.client?.close();
    } catch {}
    try {
      await this.transport?.close();
    } catch {}
  }
}
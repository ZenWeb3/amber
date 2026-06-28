import { McpClient, McpServerConfig, McpTool } from './client';

export interface RegisteredTool {
  serverId: string;
  toolName: string;        // original tool name in the server
  qualifiedName: string;   // prefixed, e.g. "github__list_pull_requests"
  description: string;
  inputSchema: any;
}

const SEP = '__';

/**
 * the registry aggregates all running MCP clients into one tool surface.
 * amber's brain sees a flat list of qualified tool names; the registry
 * routes each call back to the right underlying server.
 */
export class McpRegistry {
  private clients = new Map<string, McpClient>();
  private tools: RegisteredTool[] = [];

  async register(config: McpServerConfig): Promise<void> {
    const client = new McpClient(config);
    try {
      await client.start();
    } catch (err) {
      console.error(`[mcp] failed to start ${config.id}:`, err);
      throw err;
    }

    this.clients.set(config.id, client);

    for (const tool of client.getTools()) {
      this.tools.push({
        serverId: config.id,
        toolName: tool.name,
        qualifiedName: `${config.id}${SEP}${tool.name}`,
        description: tool.description || `${config.id} ${tool.name}`,
        inputSchema: tool.inputSchema,
      });
    }

    console.log(`[mcp] ${config.id} ready (${client.getTools().length} tools)`);
  }

  getAllTools(): RegisteredTool[] {
    return this.tools;
  }

  async call(qualifiedName: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.find((t) => t.qualifiedName === qualifiedName);
    if (!tool) throw new Error(`unknown tool: ${qualifiedName}`);
    const client = this.clients.get(tool.serverId);
    if (!client) throw new Error(`client ${tool.serverId} not connected`);
    return client.callTool(tool.toolName, args);
  }

  async shutdown(): Promise<void> {
    for (const c of this.clients.values()) {
      await c.stop().catch(() => {});
    }
  }
}
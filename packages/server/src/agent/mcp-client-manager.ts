import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "@synth-deploy/core";

export interface McpToolResult {
  serverName: string;
  toolName: string;
  result: unknown;
  error?: string;
}

/**
 * Manages connections to external MCP servers (monitoring, incident management,
 * etc.) and exposes their tools/resources for pre-deployment checks and
 * diagnostic investigations.
 *
 * Design principles:
 * - Graceful degradation: unreachable servers are logged and skipped, never block deployments
 * - All external data access must be recorded to the Debrief by the caller
 * - Lightweight: if no servers are configured, the manager is a no-op
 */
export class McpClientManager {
  private clients: Map<string, { client: Client; config: McpServerConfig }> =
    new Map();

  async connect(config: McpServerConfig): Promise<void> {
    try {
      const transport = new StreamableHTTPClientTransport(new URL(config.url));
      const client = new Client({
        name: "synth-server",
        version: "0.1.0",
      });
      await client.connect(transport);
      this.clients.set(config.name, { client, config });
    } catch (error) {
      // Graceful degradation -- log but don't throw
      console.warn(
        `[MCP] Failed to connect to ${config.name} at ${config.url}: ${error}`,
      );
    }
  }

  async connectAll(configs: McpServerConfig[]): Promise<void> {
    await Promise.allSettled(configs.map((c) => this.connect(c)));
  }

  async listTools(): Promise<
    Array<{ server: string; name: string; description?: string }>
  > {
    const tools: Array<{
      server: string;
      name: string;
      description?: string;
    }> = [];
    for (const [name, { client }] of this.clients) {
      try {
        const result = await client.listTools();
        for (const tool of result.tools) {
          tools.push({
            server: name,
            name: tool.name,
            description: tool.description,
          });
        }
      } catch {
        // Server unreachable -- skip
      }
    }
    return tools;
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const entry = this.clients.get(serverName);
    if (!entry) {
      return {
        serverName,
        toolName,
        result: null,
        error: `Server '${serverName}' not connected`,
      };
    }
    try {
      const result = await entry.client.callTool({
        name: toolName,
        arguments: args,
      });
      return { serverName, toolName, result: result.content };
    } catch (error) {
      return { serverName, toolName, result: null, error: String(error) };
    }
  }

  async listResources(
    serverName: string,
  ): Promise<Array<{ uri: string; name?: string }>> {
    const entry = this.clients.get(serverName);
    if (!entry) return [];
    try {
      const result = await entry.client.listResources();
      return result.resources.map((r) => ({ uri: r.uri, name: r.name }));
    } catch {
      return [];
    }
  }

  getConnectedServers(): string[] {
    return Array.from(this.clients.keys());
  }

  async disconnect(serverName: string): Promise<void> {
    const entry = this.clients.get(serverName);
    if (entry) {
      try {
        await entry.client.close();
      } catch {
        /* ignore */
      }
      this.clients.delete(serverName);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const name of this.clients.keys()) {
      await this.disconnect(name);
    }
  }
}

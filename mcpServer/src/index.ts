#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketHandler } from './websocketHandler.js';
import { registerTools } from './toolDefinitions.js';

class UnityMCPServer {
  private server: Server;
  private wsHandler: WebSocketHandler;

  constructor() {
    // Initialize MCP Server
    this.server = new Server(
      {
        name: 'unity-mcp-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize WebSocket Handler for Unity communication
    this.wsHandler = new WebSocketHandler(8080);

    // Register MCP tools
    registerTools(this.server, this.wsHandler);

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private async cleanup() {
    console.error('Cleaning up resources...');
    await this.wsHandler.close();
    await this.server.close();
  }

  async run() {
    // Connect to stdio for MCP communication
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[Unity MCP] Server running and ready to accept connections');
  }
}

// Start the server
const server = new UnityMCPServer();
server.run().catch(err => {
  console.error('Fatal error in MCP server:', err);
  process.exit(1);
});
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketHandler } from './websocketHandler.js';
import { registerTools } from './toolDefinitions.js';
import { registerFilesystemTools } from './filesystemTools.js';
import path from 'path';

class UnityMCPServer {
  private server: Server;
  private wsHandler: WebSocketHandler;

  constructor() {
    // Initialize MCP Server
    this.server = new Server(
      {
        name: 'unity-mcp-server',
        version: '0.2.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Get port from environment variable or use default
    // Add port range to try if the default port is taken
    let wsPort = parseInt(process.env.MCP_WEBSOCKET_PORT || '8080');
    
    // Determine Unity project path - with improved path sanitization
    let projectPath = process.env.UNITY_PROJECT_PATH || path.resolve(process.cwd());
    
    // Sanitize the path to remove any unexpected characters
    projectPath = projectPath.replace(/["']/g, '');
    
    // Fix potential issue with backslashes being removed
    projectPath = path.normalize(projectPath);
    
    // Make sure path ends with a directory separator if it's missing
    if (!projectPath.endsWith(path.sep)) {
      projectPath += path.sep;
    }
    
    console.error(`[Unity MCP] Using project path: ${projectPath}`);
    
    // Set the environment variable for other modules to use
    process.env.UNITY_PROJECT_PATH = projectPath;
    
    // Initialize WebSocket Handler for Unity communication
    // It will automatically try different ports if the initial one is taken
    this.wsHandler = new WebSocketHandler(wsPort);

    // Register MCP tools
    registerTools(this.server, this.wsHandler);
    
    // Register filesystem tools to access Unity project files
    registerFilesystemTools(this.server, this.wsHandler);

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
    
    // Also handle SIGTERM for clean Docker container shutdown
    process.on('SIGTERM', async () => {
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
    console.error('[Unity MCP] WebSocket server listening on port', this.wsHandler.port);
  }
}

// Start the server
const server = new UnityMCPServer();
server.run().catch(err => {
  console.error('Fatal error in MCP server:', err);
  process.exit(1);
});
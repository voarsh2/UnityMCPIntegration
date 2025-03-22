#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketHandler } from './websocketHandler.js';
import { registerTools } from './toolDefinitions.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

class UnityMCPServer {
  private server: Server;
  private wsHandler: WebSocketHandler;
  private toolsCleanup: { cleanup: () => void };
  
  // Static tracking of server instances
  private static instance: UnityMCPServer | null = null;

  constructor() {
    // Singleton pattern - ensure only one server instance
    if (UnityMCPServer.instance) {
      throw new Error('MCP Server is already running');
    }
    
    UnityMCPServer.instance = this;
    
    // Initialize MCP Server
    this.server = new Server(
      { name: 'unity-mcp-server', version: '0.2.0' },
      { capabilities: { tools: {} } }
    );

    // Setup project paths
    this.setupProjectPaths();
    
    // Set up WebSocket handler with fixed port 8090
    const wsPort = parseInt(process.env.MCP_WEBSOCKET_PORT || '8090');
    this.wsHandler = new WebSocketHandler(wsPort);

    // Register tools
    this.toolsCleanup = registerTools(this.server, this.wsHandler);
    
    // Setup error handling
    this.server.onerror = (error) => {
      // Ignore JSON parse errors during shutdown
      if (error instanceof SyntaxError && error.message.includes('Unexpected end of JSON')) {
        return;
      }
      console.error('[MCP Error]', error);
    };
    
    // Setup cleanup handlers with forced exit
    process.on('SIGINT', () => this.handleShutdown('SIGINT'));
    process.on('SIGTERM', () => this.handleShutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
      console.error('[Unity MCP] Uncaught exception:', err);
      this.handleShutdown('uncaughtException', 1);
    });
  }

  private handleShutdown(signal: string, exitCode: number = 0): void {
    console.error(`[Unity MCP] Received ${signal} signal - cleaning up...`);
    
    // Set a forced exit timeout
    const forceExitTimeout = setTimeout(() => {
      console.error('[Unity MCP] Forced exit after timeout');
      process.exit(exitCode);
    }, 2000);
    
    // Perform cleanup and exit
    this.cleanup().catch(console.error).finally(() => {
      clearTimeout(forceExitTimeout); 
      // Clear instance reference
      UnityMCPServer.instance = null;
      process.exit(exitCode);
    });
  }

  private setupProjectPaths(): void {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    console.error(`[Unity MCP] Server starting from directory: ${__dirname}`);
    
    // Find Unity project path
    let projectRootPath = process.env.UNITY_PROJECT_PATH || '';
    
    if (!projectRootPath) {
      // Try to find Assets folder in parent directories
      let currentDir = __dirname;
      while (currentDir && path.dirname(currentDir) !== currentDir) {
        const assetsDir = path.join(currentDir, 'Assets');
        try {
          if (fs.existsSync(assetsDir) && fs.statSync(assetsDir).isDirectory()) {
            projectRootPath = currentDir;
            break;
          }
        } catch { /* ignore errors */ }
        currentDir = path.dirname(currentDir);
      }
      
      // If still not found, use current directory
      if (!projectRootPath) {
        projectRootPath = process.cwd();
      }
    }
    
    // Set the environment variable
    process.env.UNITY_PROJECT_PATH = path.join(projectRootPath, 'Assets');
  }

  public async cleanup(): Promise<void> {
    console.error('[Unity MCP] Cleaning up resources...');
    
    try {
      // Clean up tools first to handle any pending commands
      if (this.toolsCleanup) {
        this.toolsCleanup.cleanup();
      }
      
      // Close websocket handler
      if (this.wsHandler) {
        try {
          await Promise.race([
            this.wsHandler.close(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('WebSocket close timed out')), 1000))
          ]);
        } catch (error) {
          console.error('[Unity MCP] Error closing WebSocket handler:', error);
        }
      }
      
      // Then close the MCP server
      if (this.server) {
        try {
          await Promise.race([
            this.server.close(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Server close timed out')), 1000))
          ]);
        } catch (error) {
          // Ignore JSON parse errors during shutdown
          if (!(error instanceof SyntaxError && error.message.includes('Unexpected end of JSON'))) {
            console.error('[Unity MCP] Error closing MCP server:', error);
          }
        }
      }
      
      // Clear the instance reference
      UnityMCPServer.instance = null;
      
      console.error('[Unity MCP] Cleanup completed');
    } catch (error) {
      console.error('[Unity MCP] Error during cleanup:', error);
    }
  }

  async run(): Promise<void> {
    try {
      // Connect to stdio transport
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      
      console.error('[Unity MCP] Server running and ready to accept connections');
      console.error('[Unity MCP] WebSocket server listening on port', this.wsHandler.port);
      console.error('[Unity MCP] Commands will be buffered for up to 120 seconds if Unity is not connected');
    } catch (error) {
      console.error('[Unity MCP] Error starting server:', error);
      await this.cleanup();
      throw error;
    }
  }
}

// Start the server
const server = new UnityMCPServer();
server.run().catch(console.error);
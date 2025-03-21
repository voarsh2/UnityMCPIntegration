#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketHandler } from './websocketHandler.js';
import { registerTools } from './toolDefinitions.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// A simple flag to prevent multiple initializations
let isServerRunning = false;

class UnityMCPServer {
  private server: Server;
  private wsHandler: WebSocketHandler;
  private isShuttingDown: boolean = false;
  private toolsCleanup: { cleanup: () => void } | null = null;

  constructor() {
    if (isServerRunning) {
      throw new Error('MCP Server is already running');
    }
    
    isServerRunning = true;
    
    // Initialize MCP Server
    this.server = new Server(
      { name: 'unity-mcp-server', version: '0.2.0' },
      { capabilities: { tools: {} } }
    );

    // Get project paths
    const projectRootPath = this.setupProjectPaths();
    
    // Set up WebSocket handler with fixed port 8090
    const wsPort = parseInt(process.env.MCP_WEBSOCKET_PORT || '8090');
    this.wsHandler = new WebSocketHandler(wsPort);

    // Register tools
    this.toolsCleanup = registerTools(this.server, this.wsHandler);
    
    // Setup error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    this.setupCleanupHandlers();
  }

  private setupProjectPaths(): string {
    // Get directory path
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    console.error(`[Unity MCP] Server starting from directory: ${__dirname}`);
    
    // Find Unity project path
    let projectRootPath = process.env.UNITY_PROJECT_PATH || this.determineUnityProjectPath(__dirname);
    projectRootPath = path.normalize(projectRootPath.replace(/["']/g, ''));
    
    // Ensure it ends with a path separator
    if (!projectRootPath.endsWith(path.sep)) {
      projectRootPath += path.sep;
    }
    
    // Get Assets path
    const assetsPath = path.join(projectRootPath, 'Assets') + path.sep;
    
    // Set the environment variable
    try {
      if (fs.existsSync(assetsPath) && fs.statSync(assetsPath).isDirectory()) {
        console.error(`[Unity MCP] Using project path: ${assetsPath}`);
        process.env.UNITY_PROJECT_PATH = assetsPath;
      } else {
        console.error(`[Unity MCP] WARNING: Assets folder not found at ${assetsPath}`);
        console.error(`[Unity MCP] Using project root instead: ${projectRootPath}`);
        process.env.UNITY_PROJECT_PATH = projectRootPath;
      }
    } catch (error) {
      console.error(`[Unity MCP] Error checking project path: ${error}`);
      process.env.UNITY_PROJECT_PATH = process.cwd();
    }
    
    return projectRootPath;
  }

  private setupCleanupHandlers(): void {
    // Ensure cleanup happens only once
    let cleanupCalled = false;
    
    const cleanup = async (signal: string) => {
      if (cleanupCalled || this.isShuttingDown) return;
      
      cleanupCalled = true;
      this.isShuttingDown = true;
      console.error(`[Unity MCP] Received ${signal} signal - cleaning up...`);
      
      await this.cleanup();
      isServerRunning = false;
      
      // Don't exit the process - let Node.js handle that naturally
      // This avoids issues with multiple process.exit() calls
    };
    
    // Handle signals
    process.once('SIGINT', () => cleanup('SIGINT'));
    process.once('SIGTERM', () => cleanup('SIGTERM'));
    process.once('beforeExit', () => cleanup('beforeExit'));
    
    // Handle uncaught exceptions
    process.once('uncaughtException', async (err) => {
      console.error('[Unity MCP] Uncaught exception:', err);
      await cleanup('uncaughtException');
      // Only force exit for uncaught exceptions
      process.exit(1);
    });
  }

  /**
   * Find the Unity project path based on script location
   */
  private determineUnityProjectPath(scriptDir: string): string {
    scriptDir = path.normalize(scriptDir);
    
    // Case 1: In Assets folder
    const assetsMatch = /^(.+?[\/\\]Assets)[\/\\].*$/i.exec(scriptDir);
    if (assetsMatch) {
      const projectRoot = path.dirname(assetsMatch[1]);
      console.error(`[Unity MCP] Detected installation in Assets folder: ${projectRoot}`);
      return projectRoot;
    }
    
    // Case 2: In Package Manager
    const libraryMatch = /^(.+?[\/\\]Library)[\/\\]PackageCache[\/\\].*$/i.exec(scriptDir);
    if (libraryMatch) {
      const projectRoot = path.dirname(libraryMatch[1]);
      console.error(`[Unity MCP] Detected installation via Package Manager: ${projectRoot}`);
      
      const assetsPath = path.join(projectRoot, 'Assets');
      if (fs.existsSync(assetsPath)) {
        return projectRoot;
      }
    }
    
    // Case 3: Check parent directories
    const dirs = scriptDir.split(path.sep).filter(Boolean);
    let currentPath = '';
    
    // For Windows, start with the drive letter
    if (scriptDir.match(/^[A-Z]:/i)) {
      currentPath = dirs.shift() + path.sep;
    }
    
    for (let i = 0; i < dirs.length; i++) {
      currentPath = path.join(currentPath, dirs[i]);
      
      // Check if this is UnityMCP directory
      if (path.basename(currentPath) === 'UnityMCP') {
        console.error(`[Unity MCP] Found UnityMCP directory at: ${currentPath}`);
        return currentPath;
      }
      
      // Check if this contains Assets folder
      const assetsDir = path.join(currentPath, 'Assets');
      try {
        if (fs.existsSync(assetsDir) && fs.statSync(assetsDir).isDirectory()) {
          console.error(`[Unity MCP] Found Unity project at: ${currentPath}`);
          return currentPath;
        }
      } catch {
        // Ignore errors checking directories
      }
    }
    
    // Fallback to current directory
    console.error('[Unity MCP] Could not detect Unity project directory. Using current directory.');
    return process.cwd();
  }

  public async cleanup(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    
    console.error('[Unity MCP] Cleaning up resources...');
    
    try {
      // Clean up tools first to handle any pending commands
      if (this.toolsCleanup) {
        this.toolsCleanup.cleanup();
      }
      
      // Close websocket handler
      if (this.wsHandler) {
        await this.wsHandler.close();
        console.error('[Unity MCP] WebSocket handler closed');
      }
      
      // Then close the MCP server
      if (this.server) {
        await this.server.close();
        console.error('[Unity MCP] MCP server closed');
      }
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

// Only start the server if it's not already running
if (!isServerRunning) {
  try {
    const server = new UnityMCPServer();
    server.run().catch(async (err) => {
      console.error('Fatal error in MCP server:', err);
      await server.cleanup();
    });
  } catch (err) {
    console.error('Error creating MCP server:', err);
  }
}
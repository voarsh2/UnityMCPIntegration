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

  constructor() {
    // Initialize MCP Server
    this.server = new Server(
      { name: 'unity-mcp-server', version: '0.2.0' },
      { capabilities: { tools: {} } }
    );

    // Setup project paths and websocket
    const wsPort = parseInt(process.env.MCP_WEBSOCKET_PORT || '5010');
    const projectRootPath = this.setupProjectPaths();
    
    // Initialize WebSocket Handler for Unity communication
    this.wsHandler = new WebSocketHandler(wsPort);

    // Register MCP tools
    registerTools(this.server, this.wsHandler);
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    this.setupShutdownHandlers();
  }

  private setupProjectPaths(): string {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    console.error(`[Unity MCP] Server starting from directory: ${__dirname}`);
    
    // Get the project root path (parent of Assets)
    let projectRootPath = process.env.UNITY_PROJECT_PATH || this.determineUnityProjectPath(__dirname);
    projectRootPath = path.normalize(projectRootPath.replace(/["']/g, ''));
    
    // Make sure path ends with a directory separator
    if (!projectRootPath.endsWith(path.sep)) {
      projectRootPath += path.sep;
    }
    
    // Create the full path to the Assets folder
    const projectPath = path.join(projectRootPath, 'Assets') + path.sep;
    this.setupEnvironmentPath(projectRootPath, projectPath);
    
    return projectRootPath;
  }

  private setupEnvironmentPath(projectRootPath: string, projectPath: string): void {
    try {
      if (fs.existsSync(projectPath)) {
        console.error(`[Unity MCP] Using project path: ${projectPath}`);
        process.env.UNITY_PROJECT_PATH = projectPath;
      } else {
        console.error(`[Unity MCP] WARNING: Assets folder not found at ${projectPath}`);
        console.error(`[Unity MCP] Using project root instead: ${projectRootPath}`);
        process.env.UNITY_PROJECT_PATH = projectRootPath;
      }
    } catch (error) {
      console.error(`[Unity MCP] Error checking project path: ${error}`);
      process.env.UNITY_PROJECT_PATH = process.cwd();
    }
  }

  private setupShutdownHandlers(): void {
    const cleanupHandler = async () => {
      await this.cleanup();
      process.exit(0);
    };
    
    process.on('SIGINT', cleanupHandler);
    process.on('SIGTERM', cleanupHandler);
  }

  /**
   * Determine the Unity project path based on the script location
   */
  private determineUnityProjectPath(scriptDir: string): string {
    scriptDir = path.normalize(scriptDir);
    console.error(`[Unity MCP] Script directory: ${scriptDir}`);
    
    // Case 1: Installed in Assets folder
    const assetsMatch = /^(.+?[\/\\]Assets)[\/\\].*$/i.exec(scriptDir);
    if (assetsMatch) {
      const projectRoot = path.dirname(assetsMatch[1]);
      console.error(`[Unity MCP] Detected installation in Assets folder: ${projectRoot}`);
      return projectRoot;
    }
    
    // Case 2: Installed via Package Manager
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
    for (const dir of this.getParentDirectories(scriptDir)) {
      // Check if this directory is "UnityMCP"
      if (path.basename(dir) === 'UnityMCP') {
        console.error(`[Unity MCP] Found UnityMCP directory at: ${dir}`);
        return dir;
      }
      
      // Check if this directory contains an Assets folder
      const assetsDir = path.join(dir, 'Assets');
      try {
        if (fs.existsSync(assetsDir) && fs.statSync(assetsDir).isDirectory()) {
          console.error(`[Unity MCP] Found Unity project at: ${dir}`);
          return dir;
        }
      } catch (e) {
        // Ignore errors checking directories
      }
    }
    
    // Fallback
    console.error('[Unity MCP] Could not detect Unity project directory. Using current directory.');
    return process.cwd();
  }

  private getParentDirectories(filePath: string): string[] {
    const result: string[] = [];
    const dirs = filePath.split(path.sep);
    
    for (let i = 1; i <= dirs.length; i++) {
      result.push(dirs.slice(0, i).join(path.sep));
    }
    
    return result;
  }

  private async cleanup() {
    console.error('Cleaning up resources...');
    await this.wsHandler.close();
    await this.server.close();
  }

  async run() {
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
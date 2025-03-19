import WebSocket, { WebSocketServer } from 'ws';
import { 
  UnityMessage, 
  UnityEditorState, 
  LogEntry,
  CommandPromise 
} from './types.js';

export class WebSocketHandler {
  private server: WebSocketServer;
  private clients: Set<WebSocket>;
  public readonly port: number;
  private unityConnection: WebSocket | null = null;
  private editorState: UnityEditorState = {
    activeGameObjects: [],
    selectedObjects: [],
    playModeState: 'Stopped',
    sceneHierarchy: {}
  };
  
  private logBuffer: LogEntry[] = [];
  private readonly maxLogBufferSize = 1000;
  private commandResultPromise: CommandPromise | null = null;
  private commandStartTime: number | null = null;
  private lastHeartbeat: number = 0;
  private connectionEstablished: boolean = false;
  private pendingRequests: Record<string, {
    resolve: (data?: any) => void;
    reject: (reason?: any) => void;
    type: string;
  }> = {};

  constructor(port: number = parseInt(process.env.MCP_WEBSOCKET_PORT || '8080')) {
    this.port = port;
    this.clients = new Set();
    
    // Create WebSocket server
    this.server = new WebSocketServer({ port });
    
    // Setup event handlers
    this.server.on('connection', this.handleConnection.bind(this));
    this.server.on('error', this.handleError.bind(this));
    
    console.error(`[WebSocket] Server initialized on port ${port}`);
  }

  private handleConnection(ws: WebSocket) {
    console.error('[WebSocket] Client connected');
    this.clients.add(ws);
    
    ws.on('message', (message: Buffer) => {
      try {
        const messageStr = message.toString();
        console.error(`[WebSocket] Received message: ${messageStr}`);
        
        // Parse message
        const data = JSON.parse(messageStr);
        
        // Handle different message types here
        this.handleMessage(data, ws);
      } catch (err) {
        console.error('[WebSocket] Error processing message:', err);
      }
    });
    
    ws.on('close', () => {
      console.error('[WebSocket] Client disconnected');
      this.clients.delete(ws);
    });
    
    ws.on('error', (error) => {
      console.error('[WebSocket] Client error:', error);
      this.clients.delete(ws);
    });
    
    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      message: 'Connected to Unity MCP WebSocket server'
    }));
  }
  
  private handleMessage(data: any, client: WebSocket) {
    // Handle Unity-specific messages here
    console.error(`[WebSocket] Handling message of type: ${data.type}`);
    
    // Add specific message handling as needed
  }
  
  private handleError(error: Error) {
    console.error('[WebSocket] Server error:', error);
  }
  
  public async sendMessage(message: string | object) {
    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
    
    const promises = Array.from(this.clients).map((client) => {
      return new Promise<void>((resolve, reject) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(messageStr, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        } else {
          resolve(); // Client not ready, skip it
        }
      });
    });
    
    await Promise.all(promises);
  }
  
  public async close() {
    // Close all client connections
    const closePromises = Array.from(this.clients).map((client) => {
      return new Promise<void>((resolve) => {
        client.terminate();
        resolve();
      });
    });
    
    await Promise.all(closePromises);
    this.clients.clear();
    
    // Close the server
    return new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private sendHandshake() {
    try {
      if (this.unityConnection && this.unityConnection.readyState === WebSocket.OPEN) {
        this.unityConnection.send(JSON.stringify({
          type: 'handshake',
          data: { message: 'MCP Server Connected' }
        }));
        console.error('[Unity MCP] Sent handshake message');
      }
    } catch (error) {
      console.error('[Unity MCP] Error sending handshake:', error);
    }
  }
  
  // Rename from sendHeartbeat to sendPing for consistency with protocol
  private sendPing() {
    try {
      if (this.unityConnection && this.unityConnection.readyState === WebSocket.OPEN) {
        this.unityConnection.send(JSON.stringify({
          type: "ping",
          data: { timestamp: Date.now() }
        }));
      }
    } catch (error) {
      console.error('[Unity MCP] Error sending ping:', error);
      this.connectionEstablished = false;
    }
  }

  private handleUnityMessage(message: UnityMessage) {
    switch (message.type) {
      case 'editorState':
        this.editorState = message.data;
        break;
      
      case 'commandResult':
        // Resolve the pending command result promise
        if (this.commandResultPromise) {
          this.commandResultPromise.resolve(message.data);
          this.commandResultPromise = null;
          this.commandStartTime = null;
        }
        break;

      case 'log':
        this.addLogEntry(message.data);
        break;
        
      case 'pong':
        // Update heartbeat reception timestamp when receiving pong
        this.lastHeartbeat = Date.now();
        this.connectionEstablished = true;
        break;

      case 'sceneInfo':
        // Handle scene info response
        const sceneRequestId = message.data?.requestId;
        if (sceneRequestId && this.pendingRequests[sceneRequestId]) {
          this.pendingRequests[sceneRequestId].resolve(message.data);
          delete this.pendingRequests[sceneRequestId];
        }
        break;
      
      case 'gameObjectsDetails':
        // Handle game objects details response
        const goRequestId = message.data?.requestId;
        if (goRequestId && this.pendingRequests[goRequestId]) {
          this.pendingRequests[goRequestId].resolve(message.data);
          delete this.pendingRequests[goRequestId];
        }
        break;
      
      default:
        console.error('[Unity MCP] Unknown message type:', (message as any).type);
    }
  }

  private addLogEntry(logEntry: LogEntry) {
    // Add to buffer, removing oldest if at capacity
    this.logBuffer.push(logEntry);
    if (this.logBuffer.length > this.maxLogBufferSize) {
      this.logBuffer.shift();
    }
  }

  public async executeEditorCommand(code: string, timeoutMs: number = 5000): Promise<any> {
    if (!this.isConnected()) {
      throw new Error('Unity Editor is not connected');
    }

    try {
      // Start timing the command execution
      this.commandStartTime = Date.now();
      
      // Send the command to Unity
      this.unityConnection!.send(JSON.stringify({
        type: 'executeEditorCommand',
        data: { code }
      }));

      // Wait for result with timeout
      return await Promise.race([
        new Promise((resolve, reject) => {
          this.commandResultPromise = { resolve, reject };
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(
            `Command execution timed out after ${timeoutMs/1000} seconds`
          )), timeoutMs)
        )
      ]);
    } catch (error) {
      // Reset command promise state if there's an error
      this.commandResultPromise = null;
      this.commandStartTime = null;
      throw error;
    }
  }

  // Return the current editor state - only used by tools, doesn't request updates
  public getEditorState(): UnityEditorState {
    return this.editorState;
  }

  public getLogEntries(options: {
    types?: string[],
    count?: number,
    fields?: string[],
    messageContains?: string,
    stackTraceContains?: string,
    timestampAfter?: string,
    timestampBefore?: string
  } = {}): Partial<LogEntry>[] {
    const {
      types,
      count = 100,
      fields,
      messageContains,
      stackTraceContains,
      timestampAfter,
      timestampBefore
    } = options;

    // Apply all filters
    let filteredLogs = this.logBuffer
      .filter(log => {
        // Type filter
        if (types && !types.includes(log.logType)) return false;
        
        // Message content filter
        if (messageContains && !log.message.includes(messageContains)) return false;
        
        // Stack trace content filter
        if (stackTraceContains && !log.stackTrace.includes(stackTraceContains)) return false;
        
        // Timestamp filters
        if (timestampAfter && new Date(log.timestamp) < new Date(timestampAfter)) return false;
        if (timestampBefore && new Date(log.timestamp) > new Date(timestampBefore)) return false;
        
        return true;
      });

    // Apply count limit
    filteredLogs = filteredLogs.slice(-count);

    // Apply field selection if specified
    if (fields?.length) {
      return filteredLogs.map(log => {
        const selectedFields: Partial<LogEntry> = {};
        fields.forEach(field => {
          if (field in log) {
            selectedFields[field as keyof LogEntry] = log[field as keyof LogEntry];
          }
        });
        return selectedFields;
      });
    }

    return filteredLogs;
  }

  public isConnected(): boolean {
    // More robust connection check
    if (this.unityConnection === null || this.unityConnection.readyState !== WebSocket.OPEN) {
      return false;
    }
    
    // Check if we've received messages from Unity recently (within last 2 minutes)
    if (!this.connectionEstablished) {
      return false;
    }
    
    // Check if we've received a heartbeat in the last 60 seconds
    const heartbeatTimeout = 60000; // 60 seconds
    if (Date.now() - this.lastHeartbeat > heartbeatTimeout) {
      console.error('[Unity MCP] Connection may be stale - no recent communication');
      return false;
    }
    
    return true;
  }
  
  public requestEditorState() {
    if (!this.isConnected()) {
      return;
    }
    
    try {
      this.unityConnection!.send(JSON.stringify({
        type: 'requestEditorState',
        data: {}
      }));
      console.error('[Unity MCP] Requested editor state');
    } catch (error) {
      console.error('[Unity MCP] Error requesting editor state:', error);
    }
  }

  public async requestSceneInfo(detailLevel: string): Promise<any> {
    if (!this.isConnected()) {
      throw new Error('Unity Editor is not connected');
    }
    
    const requestId = crypto.randomUUID();
    
    // Create a promise that will be resolved when we get the response
    const responsePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        delete this.pendingRequests[requestId];
        reject(new Error('Request for scene info timed out'));
      }, 10000); // 10 second timeout
      
      this.pendingRequests[requestId] = {
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data.sceneInfo);
        },
        reject,
        type: 'sceneInfo'
      };
    });
    
    // Send the request to Unity
    this.unityConnection!.send(JSON.stringify({
      type: 'getSceneInfo',
      data: {
        requestId,
        detailLevel
      }
    }));
    
    return responsePromise;
  }
  
  public async requestGameObjectsInfo(instanceIDs: number[], detailLevel: string): Promise<any> {
    if (!this.isConnected()) {
      throw new Error('Unity Editor is not connected');
    }
    
    const requestId = crypto.randomUUID();
    
    // Create a promise that will be resolved when we get the response
    const responsePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        delete this.pendingRequests[requestId];
        reject(new Error('Request for GameObjects info timed out'));
      }, 10000); // 10 second timeout
      
      this.pendingRequests[requestId] = {
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data.gameObjectDetails);
        },
        reject,
        type: 'gameObjectsDetails'
      };
    });
    
    // Send the request to Unity
    this.unityConnection!.send(JSON.stringify({
      type: 'getGameObjectsInfo',
      data: {
        requestId,
        instanceIDs,
        detailLevel
      }
    }));
    
    return responsePromise;
  }
}
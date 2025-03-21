import { WebSocketServer, WebSocket } from 'ws';
import { 
  UnityMessage, 
  UnityEditorState, 
  LogEntry,
  CommandPromise 
} from './types.js';

// Define connection event handler type
type ConnectionHandler = () => void;

export class WebSocketHandler {
  private wsServer: WebSocketServer | null = null;
  private _port: number;
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
  private pingInterval: NodeJS.Timeout | null = null;
  
  // Connection event handlers
  private connectHandlers: ConnectionHandler[] = [];

  constructor(port: number = 8090) {
    this._port = port;
    this.initializeWebSocketServer();
  }

  // Getter for port
  public get port(): number {
    return this._port;
  }

  // Register connect handler
  public onConnect(handler: ConnectionHandler) {
    this.connectHandlers.push(handler);
  }

  private initializeWebSocketServer(): void {
    try {
      // Create WebSocket server with fixed port
      this.wsServer = new WebSocketServer({ port: this._port });
      console.error(`[Unity MCP] WebSocket server starting on port ${this._port}`);
      
      this.wsServer.on('listening', () => {
        console.error(`[Unity MCP] WebSocket server is listening on port ${this._port}`);
      });
      
      this.wsServer.on('error', (error: any) => {
        console.error(`[Unity MCP] WebSocket server error:`, error);
        // If port is in use, log but don't try alternative ports
        if (error.code === 'EADDRINUSE') {
          console.error(`[Unity MCP] Port ${this._port} is already in use. Please ensure no other instance is running or specify a different port.`);
        }
      });
      
      this.wsServer.on('connection', this.handleConnection.bind(this));
      
    } catch (error) {
      console.error(`[Unity MCP] Failed to create WebSocket server:`, error);
    }
  }

  private closeServer(): void {
    if (this.wsServer) {
      try {
        // Close all client connections
        for (const client of this.wsServer.clients) {
          try {
            client.terminate();
          } catch (err) {
            // Ignore client termination errors
          }
        }
        
        // Close the server
        this.wsServer.close();
        console.error('[Unity MCP] WebSocket server closed');
      } catch (error) {
        console.error('[Unity MCP] Error closing WebSocket server:', error);
      }
      this.wsServer = null;
    }
  }

  private handleConnection(ws: WebSocket): void {
    console.error('[Unity MCP] Unity Editor connected');
    
    // Store connection
    this.unityConnection = ws;
    this.connectionEstablished = true;
    this.lastHeartbeat = Date.now();
    
    // Clear any existing ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    
    // Send handshake
    this.sendHandshake();
    
    // Setup message handler
    ws.on('message', (data) => {
      try {
        this.lastHeartbeat = Date.now();
        const message = JSON.parse(data.toString());
        console.error('[Unity MCP] Received message type:', message.type);
        this.handleUnityMessage(message);
      } catch (error) {
        console.error('[Unity MCP] Error handling message:', error);
      }
    });
    
    // Setup error handler
    ws.on('error', (error) => {
      console.error('[Unity MCP] WebSocket error:', error);
      this.connectionEstablished = false;
    });
    
    // Setup close handler
    ws.on('close', () => {
      console.error('[Unity MCP] Unity Editor disconnected');
      this.unityConnection = null;
      this.connectionEstablished = false;
    });
    
    // Setup ping interval (keep connection alive)
    this.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendPing();
      } else if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
      }
    }, 15000);
    
    // Trigger connection handlers
    this.notifyConnectionHandlers();
  }

  private notifyConnectionHandlers(): void {
    for (const handler of this.connectHandlers) {
      try {
        handler();
      } catch (error) {
        console.error('[Unity MCP] Error in connection handler:', error);
      }
    }
  }

  private sendHandshake(): void {
    this.sendToUnity({
      type: 'handshake',
      data: { message: 'MCP Server Connected' }
    });
  }
  
  private sendPing(): void {
    this.sendToUnity({
      type: 'ping',
      data: { timestamp: Date.now() }
    });
  }

  private sendToUnity(message: any): void {
    try {
      if (this.unityConnection && this.unityConnection.readyState === WebSocket.OPEN) {
        const messageStr = JSON.stringify(message);
        this.unityConnection.send(messageStr);
      }
    } catch (error) {
      console.error(`[Unity MCP] Error sending message:`, error);
      this.connectionEstablished = false;
    }
  }

  private handleUnityMessage(message: UnityMessage): void {
    try {
      switch (message.type) {
        case 'editorState':
          this.editorState = message.data;
          break;
        
        case 'commandResult':
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
          this.lastHeartbeat = Date.now();
          this.connectionEstablished = true;
          break;

        case 'sceneInfo':
        case 'gameObjectsDetails':
          this.handleRequestResponse(message);
          break;
        
        default:
          console.error('[Unity MCP] Unknown message type:', message);
          break;
      }
    } catch (error) {
      console.error('[Unity MCP] Error processing message:', error);
    }
  }

  private handleRequestResponse(message: UnityMessage): void {
    try {
      const requestId = message.data?.requestId;
      if (requestId && this.pendingRequests[requestId]) {
        this.pendingRequests[requestId].resolve(message.data);
        delete this.pendingRequests[requestId];
      }
    } catch (error) {
      console.error('[Unity MCP] Error handling request response:', error);
    }
  }

  private addLogEntry(logEntry: LogEntry): void {
    this.logBuffer.push(logEntry);
    if (this.logBuffer.length > this.maxLogBufferSize) {
      this.logBuffer.shift();
    }
  }

  // Public methods remain largely the same, just with improved robustness
  public async executeEditorCommand(code: string, timeoutMs: number = 5000): Promise<any> {
    // No need to buffer here as buffering is now handled at the tool level
    if (!this.isConnected()) {
      throw new Error('Unity Editor is not connected');
    }

    try {
      this.commandStartTime = Date.now();
      
      this.sendToUnity({
        type: 'executeEditorCommand',
        data: { code }
      });

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
      this.commandResultPromise = null;
      this.commandStartTime = null;
      throw error;
    }
  }

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

    // Filter logs
    let filteredLogs = this.logBuffer.filter(log => {
      if (types && !types.includes(log.logType)) return false;
      if (messageContains && !log.message.includes(messageContains)) return false;
      if (stackTraceContains && !log.stackTrace.includes(stackTraceContains)) return false;
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
    // Check WebSocket readyState
    if (!this.unityConnection || this.unityConnection.readyState !== WebSocket.OPEN) {
      return false;
    }
    
    // Check heartbeat (60 seconds timeout)
    const heartbeatTimeout = 60000;
    if (Date.now() - this.lastHeartbeat > heartbeatTimeout) {
      console.error('[Unity MCP] Connection may be stale - no recent communication');
      return false;
    }
    
    return this.connectionEstablished;
  }
  
  public requestEditorState(): void {
    this.sendToUnity({
      type: 'requestEditorState',
      data: {}
    });
  }

  public async requestSceneInfo(detailLevel: string): Promise<any> {
    return this.makeUnityRequest('getSceneInfo', { detailLevel }, 'sceneInfo');
  }
  
  public async requestGameObjectsInfo(instanceIDs: number[], detailLevel: string): Promise<any> {
    return this.makeUnityRequest('getGameObjectsInfo', { instanceIDs, detailLevel }, 'gameObjectDetails');
  }

  private async makeUnityRequest(type: string, data: any, resultField: string): Promise<any> {
    if (!this.isConnected()) {
      throw new Error('Unity Editor is not connected');
    }
    
    const requestId = crypto.randomUUID();
    data.requestId = requestId;
    
    const responsePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingRequests[requestId]) {
          delete this.pendingRequests[requestId];
          reject(new Error(`Request for ${type} timed out`));
        }
      }, 10000);
      
      this.pendingRequests[requestId] = {
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data[resultField]);
        },
        reject,
        type
      };
    });
    
    this.sendToUnity({ type, data });
    
    return responsePromise;
  }

  public async sendMessage(message: string | object): Promise<void> {
    if (!this.unityConnection || this.unityConnection.readyState !== WebSocket.OPEN) {
      return Promise.resolve();
    }
    
    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
    
    return new Promise<void>((resolve, reject) => {
      this.unityConnection!.send(messageStr, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
  
  public async close(): Promise<void> {
    // Notify all handlers that we're disconnecting
    this.connectHandlers = [];
    
    // Clear ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    
    // Close Unity connection
    if (this.unityConnection) {
      try {
        // Try to send a shutdown message
        if (this.unityConnection.readyState === WebSocket.OPEN) {
          this.unityConnection.send(JSON.stringify({
            type: 'shutdown',
            data: { message: 'Server shutting down' }
          }));
        }
        this.unityConnection.terminate();
      } catch (error) {
        console.error('[Unity MCP] Error terminating Unity connection:', error);
      }
      this.unityConnection = null;
    }
    
    // Close WebSocket server
    return new Promise<void>((resolve) => {
      if (!this.wsServer) {
        resolve();
        return;
      }
      
      try {
        this.wsServer.close(() => {
          console.error('[Unity MCP] WebSocket server closed');
          this.wsServer = null;
          resolve();
        });
      } catch (error) {
        console.error('[Unity MCP] Error closing WebSocket server:', error);
        this.wsServer = null;
        resolve();
      }
    });
  }
}
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
      this.wsServer = new WebSocketServer({ port: this._port });
      console.error(`[Unity MCP] WebSocket server starting on port ${this._port}`);
      
      this.wsServer.on('connection', this.handleConnection.bind(this));
      this.wsServer.on('error', (error) => console.error(`[Unity MCP] WebSocket server error:`, error));
    } catch (error) {
      console.error(`[Unity MCP] Failed to create WebSocket server:`, error);
    }
  }

  private handleConnection(ws: WebSocket): void {
    console.error('[Unity MCP] Unity Editor connected');
    
    this.unityConnection = ws;
    this.connectionEstablished = true;
    this.lastHeartbeat = Date.now();
    
    // Setup ping interval
    this.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendPing();
      } else {
        if (this.pingInterval) clearInterval(this.pingInterval);
      }
    }, 15000);
    
    // Send handshake
    this.sendHandshake();
    
    // Setup event handlers
    ws.on('message', (data) => {
      try {
        this.lastHeartbeat = Date.now();
        const message = JSON.parse(data.toString());
        this.handleUnityMessage(message);
      } catch (error) {
        console.error('[Unity MCP] Error handling message:', error);
      }
    });
    
    ws.on('error', () => this.connectionEstablished = false);
    
    ws.on('close', () => {
      console.error('[Unity MCP] Unity Editor disconnected');
      this.unityConnection = null;
      this.connectionEstablished = false;
    });
    
    // Notify connection handlers
    this.notifyConnectionHandlers();
  }

  private notifyConnectionHandlers(): void {
    for (const handler of this.connectHandlers) {
      try { handler(); } catch (error) { /* Ignore handler errors */ }
    }
  }

  private sendHandshake(): void {
    this.sendToUnity({ type: 'handshake', data: { message: 'MCP Server Connected' } });
  }
  
  private sendPing(): void {
    this.sendToUnity({ type: 'ping', data: { timestamp: Date.now() } });
  }

  private sendToUnity(message: any): void {
    try {
      if (this.unityConnection && this.unityConnection.readyState === WebSocket.OPEN) {
        this.unityConnection.send(JSON.stringify(message));
      }
    } catch (error) {
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
      }
    } catch (error) {
      console.error('[Unity MCP] Error processing message:', error);
    }
  }

  private handleRequestResponse(message: UnityMessage): void {
    const requestId = message.data?.requestId;
    if (requestId && this.pendingRequests[requestId]) {
      this.pendingRequests[requestId].resolve(message.data);
      delete this.pendingRequests[requestId];
    }
  }

  private addLogEntry(logEntry: LogEntry): void {
    this.logBuffer.push(logEntry);
    if (this.logBuffer.length > this.maxLogBufferSize) this.logBuffer.shift();
  }

  public async executeEditorCommand(code: string, timeoutMs: number = 5000): Promise<any> {
    await this.waitForConnection();
    
    return new Promise((resolve, reject) => {
      this.sendToUnity({
        type: 'executeEditorCommand',
        data: { code }
      });

      this.commandResultPromise = { resolve, reject };
      
      // Set timeout
      setTimeout(() => {
        if (this.commandResultPromise) {
          this.commandResultPromise = null;
          reject(new Error(`Command execution timed out after ${timeoutMs/1000} seconds`));
        }
      }, timeoutMs);
    });
  }

  private async waitForConnection(timeoutMs: number = 120000): Promise<void> {
    if (this.isConnected()) return;
    
    const startTime = Date.now();
    console.error('[Unity MCP] Waiting for Unity to connect...');
    
    return new Promise((resolve, reject) => {
      // One-time handler for when Unity connects
      const connectionHandler = () => {
        clearInterval(checkInterval);
        resolve();
      };
      
      // Add connection handler
      this.onConnect(connectionHandler);
      
      // Check periodically for timeout
      const checkInterval = setInterval(() => {
        if (this.isConnected()) {
          clearInterval(checkInterval);
          resolve();
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          reject(new Error('Timed out waiting for Unity connection'));
        }
      }, 1000);
    });
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
    }).slice(-count);

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
    return this.connectionEstablished && 
           this.unityConnection !== null && 
           this.unityConnection.readyState === WebSocket.OPEN;
  }
  
  public requestEditorState(): void {
    this.sendToUnity({ type: 'requestEditorState', data: {} });
  }

  public async requestSceneInfo(detailLevel: string): Promise<any> {
    await this.waitForConnection();
    return this.makeUnityRequest('getSceneInfo', { detailLevel }, 'sceneInfo');
  }
  
  public async requestGameObjectsInfo(instanceIDs: number[], detailLevel: string): Promise<any> {
    await this.waitForConnection();
    return this.makeUnityRequest('getGameObjectsInfo', { instanceIDs, detailLevel }, 'gameObjectDetails');
  }

  private async makeUnityRequest(type: string, data: any, resultField: string): Promise<any> {
    const requestId = crypto.randomUUID();
    data.requestId = requestId;
    
    const responsePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingRequests[requestId]) {
          delete this.pendingRequests[requestId];
          reject(new Error(`Request for ${type} timed out`));
        }
      }, 120000);
      
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
  
  public async close(): Promise<void> {
    console.error('[Unity MCP] Closing WebSocket handler');
    
    // Clear ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    
    // Close Unity connection
    if (this.unityConnection) {
      try {
        // Try to send a shutdown message if possible
        if (this.unityConnection.readyState === WebSocket.OPEN) {
          try {
            this.unityConnection.send(JSON.stringify({
              type: 'shutdown', 
              data: { message: 'Server shutting down' }
            }));
          } catch (e) {
            // Ignore send errors during shutdown
          }
        }
        
        // Force connection termination
        this.unityConnection.terminate();
        this.unityConnection = null;
      } catch (error) {
        console.error('[Unity MCP] Error terminating Unity connection:', error);
      }
    }
    
    // Close WebSocket server
    if (this.wsServer) {
      try {
        // Force terminate all clients first
        for (const client of this.wsServer.clients) {
          try {
            client.terminate();
          } catch (e) {
            // Ignore client termination errors
          }
        }
        
        // Close server without waiting for callbacks
        this.wsServer.close();
        
        // Don't wait for close event, just mark as closed
        this.wsServer = null;
        
        console.error('[Unity MCP] WebSocket server closed');
      } catch (error) {
        console.error('[Unity MCP] Error closing WebSocket server:', error);
        this.wsServer = null;
      }
    }
    
    // Don't wait for async callbacks that might never happen
    this.pendingRequests = {};
    
    console.error('[Unity MCP] WebSocket handler closed successfully');
  }
}
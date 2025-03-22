import { WebSocketServer, WebSocket } from 'ws';
import { 
  UnityMessage, 
  UnityEditorState, 
  LogEntry,
  CommandPromise 
} from './types.js';

export class WebSocketHandler {
  private wsServer!: WebSocketServer; // Add definite assignment assertion
  private _port: number; // Make this a private field, not readonly
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

  constructor(port: number = 5010) {
    this._port = port; // Store in private field
    this.initializeWebSocketServer(port);
  }

  // Add a getter to expose port as readonly
  public get port(): number {
    return this._port;
  }

  private initializeWebSocketServer(port: number): void {
    try {
      this.wsServer = new WebSocketServer({ port });
      this.setupWebSocketServer();
      console.error(`[Unity MCP] WebSocket server started on port ${this._port}`);
    } catch (error) {
      console.error(`[Unity MCP] ERROR starting WebSocket server on port ${port}:`, error);
      this.tryAlternativePort(port);
    }
  }

  private tryAlternativePort(originalPort: number): void {
    try {
      const alternativePort = originalPort + 1;
      console.error(`[Unity MCP] Trying alternative port ${alternativePort}...`);
      this._port = alternativePort; // Update the private field instead of readonly property
      this.wsServer = new WebSocketServer({ port: alternativePort });
      this.setupWebSocketServer();
      console.error(`[Unity MCP] WebSocket server started on alternative port ${this._port}`);
    } catch (secondError) {
      console.error(`[Unity MCP] FATAL: Could not start WebSocket server:`, secondError);
      throw new Error(`Failed to start WebSocket server: ${secondError}`);
    }
  }

  private setupWebSocketServer() {
    console.error(`[Unity MCP] WebSocket server starting on port ${this._port}`);
    
    this.wsServer.on('listening', () => {
      console.error('[Unity MCP] WebSocket server is listening for connections');
    });
    
    this.wsServer.on('error', (error) => {
      console.error('[Unity MCP] WebSocket server error:', error);
    });
    
    this.wsServer.on('connection', this.handleNewConnection.bind(this));
  }

  private handleNewConnection(ws: WebSocket): void {
    console.error('[Unity MCP] Unity Editor connected');
    this.unityConnection = ws;
    this.connectionEstablished = true;
    this.lastHeartbeat = Date.now();
    
    // Send a simple handshake message to verify connection
    this.sendHandshake();
    
    ws.on('message', (data) => this.handleIncomingMessage(data));
    
    ws.on('error', (error) => {
      console.error('[Unity MCP] WebSocket error:', error);
      this.connectionEstablished = false;
    });
    
    ws.on('close', () => {
      console.error('[Unity MCP] Unity Editor disconnected');
      this.unityConnection = null;
      this.connectionEstablished = false;
    });
    
    // Keep the automatic heartbeat for internal connection validation
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendPing();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000); // Send heartbeat every 30 seconds
  }

  private handleIncomingMessage(data: any): void {
    try {
      // Update heartbeat on any message
      this.lastHeartbeat = Date.now();
      
      const message = JSON.parse(data.toString());
      console.error('[Unity MCP] Received message type:', message.type);
      
      this.handleUnityMessage(message);
    } catch (error) {
      console.error('[Unity MCP] Error handling message:', error);
    }
  }

  private sendHandshake() {
    this.sendToUnity({
      type: 'handshake',
      data: { message: 'MCP Server Connected' }
    });
  }
  
  // Renamed from sendHeartbeat to sendPing for consistency with protocol
  private sendPing() {
    this.sendToUnity({
      type: "ping",
      data: { timestamp: Date.now() }
    });
  }

  // Helper method to safely send messages to Unity
  private sendToUnity(message: any): void {
    try {
      if (this.unityConnection && this.unityConnection.readyState === WebSocket.OPEN) {
        this.unityConnection.send(JSON.stringify(message));
      }
    } catch (error) {
      console.error(`[Unity MCP] Error sending message: ${error}`);
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
      case 'gameObjectsDetails':
        this.handleRequestResponse(message);
        break;
      
      default:
        console.error('[Unity MCP] Unknown message type:', message);
        break;
    }
  }

  private handleRequestResponse(message: UnityMessage): void {
    const requestId = message.data?.requestId;
    if (requestId && this.pendingRequests[requestId]) {
      // Fix the type issue by checking the property exists first
      if (this.pendingRequests[requestId]) {
        this.pendingRequests[requestId].resolve(message.data);
        delete this.pendingRequests[requestId];
      }
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
      this.sendToUnity({
        type: 'executeEditorCommand',
        data: { code }
      });

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
    let filteredLogs = this.filterLogs(types, messageContains, stackTraceContains, 
                                     timestampAfter, timestampBefore);

    // Apply count limit
    filteredLogs = filteredLogs.slice(-count);

    // Apply field selection if specified
    if (fields?.length) {
      return this.selectFields(filteredLogs, fields);
    }

    return filteredLogs;
  }

  private filterLogs(types?: string[], messageContains?: string, 
                   stackTraceContains?: string, timestampAfter?: string, 
                   timestampBefore?: string): LogEntry[] {
    return this.logBuffer.filter(log => {
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
  }

  private selectFields(logs: LogEntry[], fields: string[]): Partial<LogEntry>[] {
    return logs.map(log => {
      const selectedFields: Partial<LogEntry> = {};
      fields.forEach(field => {
        if (field in log) {
          selectedFields[field as keyof LogEntry] = log[field as keyof LogEntry];
        }
      });
      return selectedFields;
    });
  }

  public isConnected(): boolean {
    // More robust connection check
    if (this.unityConnection === null || this.unityConnection.readyState !== WebSocket.OPEN) {
      return false;
    }
    
    // Check if we've received messages from Unity recently
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
    
    // Create a promise that will be resolved when we get the response
    const responsePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        delete this.pendingRequests[requestId];
        reject(new Error(`Request for ${type} timed out`));
      }, 10000); // 10 second timeout
      
      this.pendingRequests[requestId] = {
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data[resultField]);
        },
        reject,
        type
      };
    });
    
    // Send the request to Unity
    this.sendToUnity({
      type,
      data
    });
    
    return responsePromise;
  }

  // Support for file system tools by adding a method to send generic messages
  public async sendMessage(message: string | object) {
    if (this.unityConnection && this.unityConnection.readyState === WebSocket.OPEN) {
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
    return Promise.resolve();
  }
  
  public async close() {
    if (this.unityConnection) {
      try {
        this.unityConnection.close();
      } catch (error) {
        console.error('[Unity MCP] Error closing Unity connection:', error);
      }
      this.unityConnection = null;
    }
    
    return new Promise<void>((resolve) => {
      try {
        this.wsServer.close(() => {
          console.error('[Unity MCP] WebSocket server closed');
          resolve();
        });
      } catch (error) {
        console.error('[Unity MCP] Error closing WebSocket server:', error);
        resolve(); // Resolve anyway to allow the process to exit
      }
    });
  }
}
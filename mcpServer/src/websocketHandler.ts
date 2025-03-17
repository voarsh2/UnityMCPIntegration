import { WebSocketServer, WebSocket } from 'ws';
import { 
  UnityMessage, 
  UnityEditorState, 
  LogEntry,
  CommandPromise 
} from './types.js';

export class WebSocketHandler {
  private wsServer: WebSocketServer;
  private unityConnection: WebSocket | null = null;
  private editorState: UnityEditorState = {
    activeGameObjects: [],
    selectedObjects: [],
    playModeState: 'Stopped',
    sceneHierarchy: {},
    projectStructure: {}
  };
  
  private logBuffer: LogEntry[] = [];
  private readonly maxLogBufferSize = 1000;
  private commandResultPromise: CommandPromise | null = null;
  private commandStartTime: number | null = null;

  constructor(port: number = 8080) {
    // Initialize WebSocket Server
    this.wsServer = new WebSocketServer({ port });
    this.setupWebSocketServer();
  }

  private setupWebSocketServer() {
    console.error('[Unity MCP] WebSocket server starting on port 8080');
    
    this.wsServer.on('listening', () => {
      console.error('[Unity MCP] WebSocket server is listening for connections');
    });

    this.wsServer.on('error', (error) => {
      console.error('[Unity MCP] WebSocket server error:', error);
    });

    this.wsServer.on('connection', (ws: WebSocket) => {
      console.error('[Unity MCP] Unity Editor connected');
      this.unityConnection = ws;

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as UnityMessage;
          console.error('[Unity MCP] Received message type:', message.type);
          this.handleUnityMessage(message);
        } catch (error) {
          console.error('[Unity MCP] Error handling message:', error);
        }
      });

      ws.on('error', (error) => {
        console.error('[Unity MCP] WebSocket error:', error);
      });

      ws.on('close', () => {
        console.error('[Unity MCP] Unity Editor disconnected');
        this.unityConnection = null;
      });
    });
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
    if (!this.unityConnection || this.unityConnection.readyState !== WebSocket.OPEN) {
      throw new Error('Unity Editor is not connected');
    }

    try {
      // Start timing the command execution
      this.commandStartTime = Date.now();
      
      // Send the command to Unity
      this.unityConnection.send(JSON.stringify({
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
    return this.unityConnection !== null && 
           this.unityConnection.readyState === WebSocket.OPEN;
  }

  public async close(): Promise<void> {
    if (this.unityConnection) {
      this.unityConnection.close();
      this.unityConnection = null;
    }
    
    return new Promise<void>((resolve) => {
      this.wsServer.close(() => {
        console.error('[Unity MCP] WebSocket server closed');
        resolve();
      });
    });
  }
}
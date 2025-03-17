import { WebSocketServer, WebSocket } from 'ws';
export class WebSocketHandler {
    wsServer;
    unityConnection = null;
    editorState = {
        activeGameObjects: [],
        selectedObjects: [],
        playModeState: 'Stopped',
        sceneHierarchy: {},
        projectStructure: {}
    };
    logBuffer = [];
    maxLogBufferSize = 1000;
    commandResultPromise = null;
    commandStartTime = null;
    constructor(port = 8080) {
        // Initialize WebSocket Server
        this.wsServer = new WebSocketServer({ port });
        this.setupWebSocketServer();
    }
    setupWebSocketServer() {
        console.error('[Unity MCP] WebSocket server starting on port 8080');
        this.wsServer.on('listening', () => {
            console.error('[Unity MCP] WebSocket server is listening for connections');
        });
        this.wsServer.on('error', (error) => {
            console.error('[Unity MCP] WebSocket server error:', error);
        });
        this.wsServer.on('connection', (ws) => {
            console.error('[Unity MCP] Unity Editor connected');
            this.unityConnection = ws;
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    console.error('[Unity MCP] Received message type:', message.type);
                    this.handleUnityMessage(message);
                }
                catch (error) {
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
    handleUnityMessage(message) {
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
                console.error('[Unity MCP] Unknown message type:', message.type);
        }
    }
    addLogEntry(logEntry) {
        // Add to buffer, removing oldest if at capacity
        this.logBuffer.push(logEntry);
        if (this.logBuffer.length > this.maxLogBufferSize) {
            this.logBuffer.shift();
        }
    }
    async executeEditorCommand(code, timeoutMs = 5000) {
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
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Command execution timed out after ${timeoutMs / 1000} seconds`)), timeoutMs))
            ]);
        }
        catch (error) {
            // Reset command promise state if there's an error
            this.commandResultPromise = null;
            this.commandStartTime = null;
            throw error;
        }
    }
    getEditorState() {
        return this.editorState;
    }
    getLogEntries(options = {}) {
        const { types, count = 100, fields, messageContains, stackTraceContains, timestampAfter, timestampBefore } = options;
        // Apply all filters
        let filteredLogs = this.logBuffer
            .filter(log => {
            // Type filter
            if (types && !types.includes(log.logType))
                return false;
            // Message content filter
            if (messageContains && !log.message.includes(messageContains))
                return false;
            // Stack trace content filter
            if (stackTraceContains && !log.stackTrace.includes(stackTraceContains))
                return false;
            // Timestamp filters
            if (timestampAfter && new Date(log.timestamp) < new Date(timestampAfter))
                return false;
            if (timestampBefore && new Date(log.timestamp) > new Date(timestampBefore))
                return false;
            return true;
        });
        // Apply count limit
        filteredLogs = filteredLogs.slice(-count);
        // Apply field selection if specified
        if (fields?.length) {
            return filteredLogs.map(log => {
                const selectedFields = {};
                fields.forEach(field => {
                    if (field in log) {
                        selectedFields[field] = log[field];
                    }
                });
                return selectedFields;
            });
        }
        return filteredLogs;
    }
    isConnected() {
        return this.unityConnection !== null &&
            this.unityConnection.readyState === WebSocket.OPEN;
    }
    async close() {
        if (this.unityConnection) {
            this.unityConnection.close();
            this.unityConnection = null;
        }
        return new Promise((resolve) => {
            this.wsServer.close(() => {
                console.error('[Unity MCP] WebSocket server closed');
                resolve();
            });
        });
    }
}

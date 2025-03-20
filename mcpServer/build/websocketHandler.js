import { WebSocketServer, WebSocket } from 'ws';
export class WebSocketHandler {
    wsServer;
    port;
    unityConnection = null;
    editorState = {
        activeGameObjects: [],
        selectedObjects: [],
        playModeState: 'Stopped',
        sceneHierarchy: {}
    };
    logBuffer = [];
    maxLogBufferSize = 1000;
    commandResultPromise = null;
    commandStartTime = null;
    lastHeartbeat = 0;
    connectionEstablished = false;
    pendingRequests = {};
    constructor(port = 5010) {
        this.port = port;
        try {
            // Initialize WebSocket Server
            this.wsServer = new WebSocketServer({ port });
            this.setupWebSocketServer();
            console.error(`[Unity MCP] WebSocket server started on port ${this.port}`);
        }
        catch (error) {
            console.error(`[Unity MCP] ERROR starting WebSocket server on port ${port}:`, error);
            // Try with a different port if the specified one fails
            try {
                const alternativePort = port + 1;
                console.error(`[Unity MCP] Trying alternative port ${alternativePort}...`);
                this.port = alternativePort;
                this.wsServer = new WebSocketServer({ port: alternativePort });
                this.setupWebSocketServer();
                console.error(`[Unity MCP] WebSocket server started on alternative port ${this.port}`);
            }
            catch (secondError) {
                console.error(`[Unity MCP] FATAL: Could not start WebSocket server:`, secondError);
                // Since this is a constructor, we can't use async/await with process.exit
                // Let the error propagate up to be handled by the caller
                throw new Error(`Failed to start WebSocket server: ${secondError}`);
            }
        }
    }
    setupWebSocketServer() {
        console.error(`[Unity MCP] WebSocket server starting on port ${this.port}`);
        this.wsServer.on('listening', () => {
            console.error('[Unity MCP] WebSocket server is listening for connections');
        });
        this.wsServer.on('error', (error) => {
            console.error('[Unity MCP] WebSocket server error:', error);
        });
        this.wsServer.on('connection', (ws) => {
            console.error('[Unity MCP] Unity Editor connected');
            this.unityConnection = ws;
            this.connectionEstablished = true;
            this.lastHeartbeat = Date.now();
            // Send a simple handshake message to verify connection
            this.sendHandshake();
            ws.on('message', (data) => {
                try {
                    // Update heartbeat on any message
                    this.lastHeartbeat = Date.now();
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
                }
                else {
                    clearInterval(pingInterval);
                }
            }, 30000); // Send heartbeat every 30 seconds
        });
    }
    sendHandshake() {
        try {
            if (this.unityConnection && this.unityConnection.readyState === WebSocket.OPEN) {
                this.unityConnection.send(JSON.stringify({
                    type: 'handshake',
                    data: { message: 'MCP Server Connected' }
                }));
                console.error('[Unity MCP] Sent handshake message');
            }
        }
        catch (error) {
            console.error('[Unity MCP] Error sending handshake:', error);
        }
    }
    // Renamed from sendHeartbeat to sendPing for consistency with protocol
    sendPing() {
        try {
            if (this.unityConnection && this.unityConnection.readyState === WebSocket.OPEN) {
                this.unityConnection.send(JSON.stringify({
                    type: "ping",
                    data: { timestamp: Date.now() }
                }));
            }
        }
        catch (error) {
            console.error('[Unity MCP] Error sending ping:', error);
            this.connectionEstablished = false;
        }
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
                console.error('[Unity MCP] Unknown message type:');
                break;
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
        if (!this.isConnected()) {
            throw new Error('Unity Editor is not connected');
        }
        try {
            // Start timing the command execution
            this.commandStartTime = Date.now();
            // Send the command to Unity
            if (this.unityConnection) {
                this.unityConnection.send(JSON.stringify({
                    type: 'executeEditorCommand',
                    data: { code }
                }));
            }
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
    // Return the current editor state - only used by tools, doesn't request updates
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
    requestEditorState() {
        if (!this.isConnected() || !this.unityConnection) {
            return;
        }
        try {
            this.unityConnection.send(JSON.stringify({
                type: 'requestEditorState',
                data: {}
            }));
            console.error('[Unity MCP] Requested editor state');
        }
        catch (error) {
            console.error('[Unity MCP] Error requesting editor state:', error);
        }
    }
    async requestSceneInfo(detailLevel) {
        if (!this.isConnected() || !this.unityConnection) {
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
        this.unityConnection.send(JSON.stringify({
            type: 'getSceneInfo',
            data: {
                requestId,
                detailLevel
            }
        }));
        return responsePromise;
    }
    async requestGameObjectsInfo(instanceIDs, detailLevel) {
        if (!this.isConnected() || !this.unityConnection) {
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
        this.unityConnection.send(JSON.stringify({
            type: 'getGameObjectsInfo',
            data: {
                requestId,
                instanceIDs,
                detailLevel
            }
        }));
        return responsePromise;
    }
    // Support for file system tools by adding a method to send generic messages
    async sendMessage(message) {
        if (this.unityConnection && this.unityConnection.readyState === WebSocket.OPEN) {
            const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
            return new Promise((resolve, reject) => {
                this.unityConnection.send(messageStr, (err) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve();
                    }
                });
            });
        }
        return Promise.resolve();
    }
    async close() {
        if (this.unityConnection) {
            try {
                this.unityConnection.close();
            }
            catch (error) {
                console.error('[Unity MCP] Error closing Unity connection:', error);
            }
            this.unityConnection = null;
        }
        return new Promise((resolve) => {
            try {
                this.wsServer.close(() => {
                    console.error('[Unity MCP] WebSocket server closed');
                    resolve();
                });
            }
            catch (error) {
                console.error('[Unity MCP] Error closing WebSocket server:', error);
                resolve(); // Resolve anyway to allow the process to exit
            }
        });
    }
}

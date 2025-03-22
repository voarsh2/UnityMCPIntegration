import { WebSocketServer, WebSocket } from 'ws';
export class WebSocketHandler {
    wsServer; // Add definite assignment assertion
    _port; // Make this a private field, not readonly
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
        this._port = port; // Store in private field
        this.initializeWebSocketServer(port);
    }
    // Add a getter to expose port as readonly
    get port() {
        return this._port;
    }
    initializeWebSocketServer(port) {
        try {
            this.wsServer = new WebSocketServer({ port });
            this.setupWebSocketServer();
            console.error(`[Unity MCP] WebSocket server started on port ${this._port}`);
        }
        catch (error) {
            console.error(`[Unity MCP] ERROR starting WebSocket server on port ${port}:`, error);
            this.tryAlternativePort(port);
        }
    }
    tryAlternativePort(originalPort) {
        try {
            const alternativePort = originalPort + 1;
            console.error(`[Unity MCP] Trying alternative port ${alternativePort}...`);
            this._port = alternativePort; // Update the private field instead of readonly property
            this.wsServer = new WebSocketServer({ port: alternativePort });
            this.setupWebSocketServer();
            console.error(`[Unity MCP] WebSocket server started on alternative port ${this._port}`);
        }
        catch (secondError) {
            console.error(`[Unity MCP] FATAL: Could not start WebSocket server:`, secondError);
            throw new Error(`Failed to start WebSocket server: ${secondError}`);
        }
    }
    setupWebSocketServer() {
        console.error(`[Unity MCP] WebSocket server starting on port ${this._port}`);
        this.wsServer.on('listening', () => {
            console.error('[Unity MCP] WebSocket server is listening for connections');
        });
        this.wsServer.on('error', (error) => {
            console.error('[Unity MCP] WebSocket server error:', error);
        });
        this.wsServer.on('connection', this.handleNewConnection.bind(this));
    }
    handleNewConnection(ws) {
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
            }
            else {
                clearInterval(pingInterval);
            }
        }, 30000); // Send heartbeat every 30 seconds
    }
    handleIncomingMessage(data) {
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
    }
    sendHandshake() {
        this.sendToUnity({
            type: 'handshake',
            data: { message: 'MCP Server Connected' }
        });
    }
    // Renamed from sendHeartbeat to sendPing for consistency with protocol
    sendPing() {
        this.sendToUnity({
            type: "ping",
            data: { timestamp: Date.now() }
        });
    }
    // Helper method to safely send messages to Unity
    sendToUnity(message) {
        try {
            if (this.unityConnection && this.unityConnection.readyState === WebSocket.OPEN) {
                this.unityConnection.send(JSON.stringify(message));
            }
        }
        catch (error) {
            console.error(`[Unity MCP] Error sending message: ${error}`);
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
            case 'gameObjectsDetails':
                this.handleRequestResponse(message);
                break;
            default:
                console.error('[Unity MCP] Unknown message type:', message);
                break;
        }
    }
    handleRequestResponse(message) {
        const requestId = message.data?.requestId;
        if (requestId && this.pendingRequests[requestId]) {
            // Fix the type issue by checking the property exists first
            if (this.pendingRequests[requestId]) {
                this.pendingRequests[requestId].resolve(message.data);
                delete this.pendingRequests[requestId];
            }
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
            this.sendToUnity({
                type: 'executeEditorCommand',
                data: { code }
            });
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
        let filteredLogs = this.filterLogs(types, messageContains, stackTraceContains, timestampAfter, timestampBefore);
        // Apply count limit
        filteredLogs = filteredLogs.slice(-count);
        // Apply field selection if specified
        if (fields?.length) {
            return this.selectFields(filteredLogs, fields);
        }
        return filteredLogs;
    }
    filterLogs(types, messageContains, stackTraceContains, timestampAfter, timestampBefore) {
        return this.logBuffer.filter(log => {
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
    }
    selectFields(logs, fields) {
        return logs.map(log => {
            const selectedFields = {};
            fields.forEach(field => {
                if (field in log) {
                    selectedFields[field] = log[field];
                }
            });
            return selectedFields;
        });
    }
    isConnected() {
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
    requestEditorState() {
        this.sendToUnity({
            type: 'requestEditorState',
            data: {}
        });
    }
    async requestSceneInfo(detailLevel) {
        return this.makeUnityRequest('getSceneInfo', { detailLevel }, 'sceneInfo');
    }
    async requestGameObjectsInfo(instanceIDs, detailLevel) {
        return this.makeUnityRequest('getGameObjectsInfo', { instanceIDs, detailLevel }, 'gameObjectDetails');
    }
    async makeUnityRequest(type, data, resultField) {
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

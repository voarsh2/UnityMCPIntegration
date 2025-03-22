import { z } from 'zod';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import path from 'path';
// Import handleFilesystemTool using ES module syntax instead of require
import { handleFilesystemTool } from './filesystemTools.js';
// File operation schemas - defined here to be used in tool definitions
export const ReadFileArgsSchema = z.object({
    path: z.string().describe('Path to the file to read. Can be absolute or relative to Unity project Assets folder. If empty, defaults to the Assets folder.'),
});
export const ReadMultipleFilesArgsSchema = z.object({
    paths: z.array(z.string()).describe('Array of file paths to read. Paths can be absolute or relative to Unity project Assets folder.'),
});
export const WriteFileArgsSchema = z.object({
    path: z.string().describe('Path to the file to write. Can be absolute or relative to Unity project Assets folder. If empty, defaults to the Assets folder.'),
    content: z.string().describe('Content to write to the file'),
});
export const EditOperation = z.object({
    oldText: z.string().describe('Text to search for - must match exactly'),
    newText: z.string().describe('Text to replace with')
});
export const EditFileArgsSchema = z.object({
    path: z.string().describe('Path to the file to edit. Can be absolute or relative to Unity project Assets folder. If empty, defaults to the Assets folder.'),
    edits: z.array(EditOperation).describe('Array of edit operations to apply'),
    dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format')
});
export const ListDirectoryArgsSchema = z.object({
    path: z.string().describe('Path to the directory to list. Can be absolute or relative to Unity project Assets folder. If empty, defaults to the Assets folder. Example: "Scenes" will list all files in the Assets/Scenes directory.'),
});
export const DirectoryTreeArgsSchema = z.object({
    path: z.string().describe('Path to the directory to get tree of. Can be absolute or relative to Unity project Assets folder. If empty, defaults to the Assets folder. Example: "Prefabs" will show the tree for Assets/Prefabs.'),
    maxDepth: z.number().optional().default(5).describe('Maximum depth to traverse'),
});
export const SearchFilesArgsSchema = z.object({
    path: z.string().describe('Path to search from. Can be absolute or relative to Unity project Assets folder. If empty, defaults to the Assets folder. Example: "Scripts" will search within Assets/Scripts.'),
    pattern: z.string().describe('Pattern to search for'),
    excludePatterns: z.array(z.string()).optional().default([]).describe('Patterns to exclude')
});
export const GetFileInfoArgsSchema = z.object({
    path: z.string().describe('Path to the file to get info for. Can be absolute or relative to Unity project Assets folder. If empty, defaults to the Assets folder.'),
});
export const FindAssetsByTypeArgsSchema = z.object({
    assetType: z.string().describe('Type of assets to find (e.g., "Material", "Prefab", "Scene", "Script")'),
    searchPath: z.string().optional().default("").describe('Directory to search in. Can be absolute or relative to Unity project Assets folder. An empty string will search the entire Assets folder.'),
    maxDepth: z.number().optional().default(1).describe('Maximum depth to search. 1 means search only in the specified directory, 2 includes immediate subdirectories, and so on. Set to -1 for unlimited depth.'),
});
// Buffer timeout in milliseconds (120 seconds)
const COMMAND_BUFFER_TIMEOUT = 120000;
export function registerTools(server, wsHandler) {
    // Determine project path from environment variable (which now should include 'Assets')
    const projectPath = process.env.UNITY_PROJECT_PATH || path.resolve(process.cwd());
    const projectRootPath = projectPath.endsWith(`Assets${path.sep}`)
        ? projectPath.slice(0, -7) // Remove 'Assets/'
        : projectPath;
    console.error(`[Unity MCP ToolDefinitions] Using project path: ${projectPath}`);
    console.error(`[Unity MCP ToolDefinitions] Using project root path: ${projectRootPath}`);
    // Buffer for tool commands that require Unity connection
    const commandBuffer = [];
    let commandProcessorInterval = null;
    // Start command processor
    startCommandProcessor();
    function startCommandProcessor() {
        if (commandProcessorInterval) {
            clearInterval(commandProcessorInterval);
        }
        commandProcessorInterval = setInterval(() => {
            processBufferedCommands(false);
        }, 5000); // Check every 5 seconds
    }
    // Process buffered commands
    function processBufferedCommands(unityJustConnected) {
        if (commandBuffer.length === 0)
            return;
        const now = Date.now();
        const remainingCommands = [];
        // Process each command in the buffer
        for (const cmd of commandBuffer) {
            const timeWaited = now - cmd.timestamp;
            const shouldExecute = unityJustConnected || timeWaited >= COMMAND_BUFFER_TIMEOUT;
            if (shouldExecute) {
                if (wsHandler.isConnected()) {
                    // Unity is connected, execute the command
                    console.error(`[Unity MCP] Executing buffered command ${cmd.name} after ${Math.round(timeWaited / 1000)} seconds`);
                    try {
                        // Execute the command based on its name
                        executeUnityTool(cmd.name, cmd.args, wsHandler)
                            .then(cmd.resolve)
                            .catch(cmd.reject);
                    }
                    catch (error) {
                        cmd.reject(error);
                    }
                }
                else if (timeWaited >= COMMAND_BUFFER_TIMEOUT) {
                    // Command timed out waiting for Unity
                    console.error(`[Unity MCP] Rejecting buffered command ${cmd.name} after ${Math.round(timeWaited / 1000)} seconds - Unity not connected`);
                    cmd.reject(new McpError(ErrorCode.InternalError, 'Unity Editor connection timed out. Command was buffered for 120 seconds, but Unity did not connect.'));
                }
                else {
                    // Keep in buffer if we're still within timeout
                    remainingCommands.push(cmd);
                }
            }
            else {
                // Not ready to execute yet, keep in buffer
                remainingCommands.push(cmd);
            }
        }
        // Update the buffer with remaining commands
        commandBuffer.length = 0;
        commandBuffer.push(...remainingCommands);
    }
    // Connection event handler for Unity
    wsHandler.onConnect(() => {
        // Process buffered commands when Unity connects
        processBufferedCommands(true);
    });
    // List all available tools (both Unity and filesystem tools)
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            // Unity Editor tools
            {
                name: 'get_current_scene_info',
                description: 'Retrieve information about the current scene in Unity Editor with configurable detail level',
                category: 'Editor State',
                tags: ['unity', 'editor', 'scene'],
                inputSchema: {
                    type: 'object',
                    properties: {
                        detailLevel: {
                            type: 'string',
                            enum: ['RootObjectsOnly', 'FullHierarchy'],
                            description: 'RootObjectsOnly: Returns just root GameObjects. FullHierarchy: Returns complete hierarchy with all children.',
                            default: 'RootObjectsOnly'
                        }
                    },
                    additionalProperties: false
                },
                returns: {
                    type: 'object',
                    description: 'Returns information about the current scene and its hierarchy based on requested detail level'
                }
            },
            {
                name: 'get_game_objects_info',
                description: 'Retrieve detailed information about specific GameObjects in the current scene',
                category: 'Editor State',
                tags: ['unity', 'editor', 'gameobjects'],
                inputSchema: {
                    type: 'object',
                    properties: {
                        instanceIDs: {
                            type: 'array',
                            items: {
                                type: 'number'
                            },
                            description: 'Array of GameObject instance IDs to get information for',
                            minItems: 1
                        },
                        detailLevel: {
                            type: 'string',
                            enum: ['BasicInfo', 'IncludeComponents', 'IncludeChildren', 'IncludeComponentsAndChildren'],
                            description: 'BasicInfo: Basic GameObject information. IncludeComponents: Includes component details. IncludeChildren: Includes child GameObjects. IncludeComponentsAndChildren: Includes both components and a full hierarchy with components on children.',
                            default: 'IncludeComponents'
                        }
                    },
                    required: ['instanceIDs'],
                    additionalProperties: false
                },
                returns: {
                    type: 'object',
                    description: 'Returns detailed information about the requested GameObjects'
                }
            },
            {
                name: 'execute_editor_command',
                description: 'Execute C# code directly in the Unity Editor - allows full flexibility including custom namespaces and multiple classes',
                category: 'Editor Control',
                tags: ['unity', 'editor', 'command', 'c#'],
                inputSchema: {
                    type: 'object',
                    properties: {
                        code: {
                            type: 'string',
                            description: 'C# code to execute in Unity Editor. You MUST define a public class named "McpScript" with a public static method named "Execute" that returns an object. Example: "public class McpScript { public static object Execute() { /* your code here */ return result; } }". You can include any necessary namespaces, additional classes, and methods.',
                            minLength: 1
                        }
                    },
                    required: ['code'],
                    additionalProperties: false
                },
                returns: {
                    type: 'object',
                    description: 'Returns the execution result, execution time, and status'
                }
            },
            {
                name: 'get_logs',
                description: 'Retrieve Unity Editor logs with filtering options',
                category: 'Debugging',
                tags: ['unity', 'editor', 'logs', 'debugging'],
                inputSchema: {
                    type: 'object',
                    properties: {
                        types: {
                            type: 'array',
                            items: {
                                type: 'string',
                                enum: ['Log', 'Warning', 'Error', 'Exception']
                            },
                            description: 'Filter logs by type'
                        },
                        count: {
                            type: 'number',
                            description: 'Maximum number of log entries to return',
                            minimum: 1,
                            maximum: 1000
                        },
                        fields: {
                            type: 'array',
                            items: {
                                type: 'string',
                                enum: ['message', 'stackTrace', 'logType', 'timestamp']
                            },
                            description: 'Specify which fields to include in the output'
                        },
                        messageContains: {
                            type: 'string',
                            description: 'Filter logs by message content'
                        },
                        stackTraceContains: {
                            type: 'string',
                            description: 'Filter logs by stack trace content'
                        },
                        timestampAfter: {
                            type: 'string',
                            description: 'Filter logs after this ISO timestamp'
                        },
                        timestampBefore: {
                            type: 'string',
                            description: 'Filter logs before this ISO timestamp'
                        }
                    },
                    additionalProperties: false
                },
                returns: {
                    type: 'array',
                    description: 'Returns an array of log entries matching the specified filters'
                }
            },
            {
                name: 'verify_connection',
                description: 'Verify that the MCP server has an active connection to Unity Editor',
                category: 'Connection',
                tags: ['unity', 'editor', 'connection'],
                inputSchema: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false
                },
                returns: {
                    type: 'object',
                    description: 'Returns connection status information'
                }
            },
            {
                name: 'get_editor_state',
                description: 'Get the current Unity Editor state including project information',
                category: 'Editor State',
                tags: ['unity', 'editor', 'project'],
                inputSchema: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false
                },
                returns: {
                    type: 'object',
                    description: 'Returns detailed information about the current Unity Editor state, project settings, and environment'
                }
            },
            // Filesystem tools - defined alongside Unity tools
            {
                name: "read_file",
                description: "Read the contents of a file from the Unity project. Paths are relative to the project's Assets folder. For example, use 'Scenes/MainScene.unity' to read Assets/Scenes/MainScene.unity.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'file'],
                inputSchema: zodToJsonSchema(ReadFileArgsSchema),
            },
            {
                name: "read_multiple_files",
                description: "Read the contents of multiple files from the Unity project simultaneously.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'file', 'batch'],
                inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema),
            },
            {
                name: "write_file",
                description: "Create a new file or completely overwrite an existing file in the Unity project.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'file', 'write'],
                inputSchema: zodToJsonSchema(WriteFileArgsSchema),
            },
            {
                name: "edit_file",
                description: "Make precise edits to a text file in the Unity project. Returns a git-style diff showing changes.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'file', 'edit'],
                inputSchema: zodToJsonSchema(EditFileArgsSchema),
            },
            {
                name: "list_directory",
                description: "Get a listing of all files and directories in a specified path in the Unity project. Paths are relative to the Assets folder unless absolute. For example, use 'Scenes' to list all files in Assets/Scenes directory. Use empty string to list the Assets folder.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'directory', 'list'],
                inputSchema: zodToJsonSchema(ListDirectoryArgsSchema),
            },
            {
                name: "directory_tree",
                description: "Get a recursive tree view of files and directories in the Unity project as a JSON structure.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'directory', 'tree'],
                inputSchema: zodToJsonSchema(DirectoryTreeArgsSchema),
            },
            {
                name: "search_files",
                description: "Recursively search for files and directories matching a pattern in the Unity project.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'search'],
                inputSchema: zodToJsonSchema(SearchFilesArgsSchema),
            },
            {
                name: "get_file_info",
                description: "Retrieve detailed metadata about a file or directory in the Unity project.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'file', 'metadata'],
                inputSchema: zodToJsonSchema(GetFileInfoArgsSchema),
            },
            {
                name: "find_assets_by_type",
                description: "Find all Unity assets of a specified type (e.g., Material, Prefab, Scene, Script) in the project. Set searchPath to an empty string to search the entire Assets folder.",
                category: "Filesystem",
                tags: ['unity', 'filesystem', 'assets', 'search'],
                inputSchema: zodToJsonSchema(FindAssetsByTypeArgsSchema),
            },
        ],
    }));
    // Handle tool calls with improved typing
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        // Special case for verify_connection which should work even if not connected
        if (name === 'verify_connection') {
            try {
                const isConnected = wsHandler.isConnected();
                // Always request fresh editor state if connected
                if (isConnected) {
                    wsHandler.requestEditorState();
                }
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                connected: isConnected,
                                timestamp: new Date().toISOString(),
                                message: isConnected
                                    ? 'Unity Editor is connected'
                                    : 'Unity Editor is not connected. Please ensure the Unity Editor is running with the MCP plugin.'
                            }, null, 2)
                        }]
                };
            }
            catch (error) {
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                connected: false,
                                timestamp: new Date().toISOString(),
                                message: 'Error checking connection status',
                                error: error instanceof Error ? error.message : 'Unknown error'
                            }, null, 2)
                        }]
                };
            }
        }
        // Check if this is a filesystem tool
        const filesystemTools = [
            "read_file", "read_multiple_files", "write_file", "edit_file",
            "list_directory", "directory_tree", "search_files", "get_file_info",
            "find_assets_by_type"
        ];
        if (filesystemTools.includes(name)) {
            try {
                return await handleFilesystemTool(name, args, projectPath);
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: "text", text: `Error: ${errorMessage}` }],
                    isError: true,
                };
            }
        }
        // For all other tools (Unity-specific), buffer if Unity isn't connected
        if (!wsHandler.isConnected()) {
            console.error(`[Unity MCP] Unity not connected, buffering ${name} command for up to 120 seconds`);
            // Return a promise that will be resolved when Unity connects or after timeout
            return new Promise((resolve, reject) => {
                // Set a timer for debugging
                const startTime = Date.now();
                const timer = setInterval(() => {
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    console.error(`[Unity MCP] Still waiting for Unity to connect (${elapsed}s elapsed) for ${name} command`);
                }, 15000); // Log every 15 seconds
                const commandEntry = {
                    name,
                    args,
                    resolve: (result) => {
                        clearInterval(timer);
                        resolve(result);
                    },
                    reject: (error) => {
                        clearInterval(timer);
                        reject(error);
                    },
                    timestamp: startTime
                };
                // Add to buffer
                commandBuffer.push(commandEntry);
            });
        }
        // If Unity is connected, execute the command immediately
        try {
            console.error(`[Unity MCP] Unity connected, executing ${name} command immediately`);
            return await executeUnityTool(name, args, wsHandler);
        }
        catch (error) {
            console.error(`[Unity MCP] Error executing ${name} command: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw error;
        }
    });
    // Execute Unity tool function
    async function executeUnityTool(name, args, wsHandler) {
        switch (name) {
            case 'get_editor_state': {
                try {
                    // Always request a fresh editor state before returning
                    wsHandler.requestEditorState();
                    // Wait a moment for the response to arrive
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    // Return the current editor state
                    const editorState = wsHandler.getEditorState();
                    return {
                        content: [{
                                type: 'text',
                                text: JSON.stringify(editorState, null, 2)
                            }]
                    };
                }
                catch (error) {
                    throw new McpError(ErrorCode.InternalError, `Failed to get editor state: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
            case 'get_current_scene_info': {
                try {
                    const detailLevel = args?.detailLevel || 'RootObjectsOnly';
                    // Send request to Unity and wait for response
                    const sceneInfo = await wsHandler.requestSceneInfo(detailLevel);
                    return {
                        content: [{
                                type: 'text',
                                text: JSON.stringify(sceneInfo, null, 2)
                            }]
                    };
                }
                catch (error) {
                    throw new McpError(ErrorCode.InternalError, `Failed to get scene info: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
            case 'get_game_objects_info': {
                try {
                    if (!args?.instanceIDs || !Array.isArray(args.instanceIDs)) {
                        throw new McpError(ErrorCode.InvalidParams, 'instanceIDs array is required');
                    }
                    const instanceIDs = args.instanceIDs;
                    const detailLevel = args?.detailLevel || 'IncludeComponents';
                    // Log more details about the request
                    console.error(`[Unity MCP] Requesting game objects info for ${instanceIDs.length} objects with detail level ${detailLevel}`);
                    // Use a longer 120-second timeout for this operation
                    const gameObjectsInfo = await wsHandler.requestGameObjectsInfo(instanceIDs, detailLevel);
                    console.error(`[Unity MCP] Successfully received game objects info response`);
                    return {
                        content: [{
                                type: 'text',
                                text: JSON.stringify(gameObjectsInfo, null, 2)
                            }]
                    };
                }
                catch (error) {
                    console.error(`[Unity MCP] Error in get_game_objects_info: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    throw new McpError(ErrorCode.InternalError, `Failed to get GameObject info: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
            case 'execute_editor_command': {
                try {
                    if (!args?.code) {
                        throw new McpError(ErrorCode.InvalidParams, 'The code parameter is required');
                    }
                    const startTime = Date.now();
                    const result = await wsHandler.executeEditorCommand(args.code);
                    const executionTime = Date.now() - startTime;
                    return {
                        content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    result,
                                    executionTime: `${executionTime}ms`,
                                    status: 'success'
                                }, null, 2)
                            }]
                    };
                }
                catch (error) {
                    if (error instanceof Error) {
                        if (error.message.includes('timed out')) {
                            throw new McpError(ErrorCode.InternalError, 'Command execution timed out. This may indicate a long-running operation or an issue with the Unity Editor.');
                        }
                        if (error.message.includes('NullReferenceException')) {
                            throw new McpError(ErrorCode.InvalidParams, 'The code attempted to access a null object. Please check that all GameObject references exist.');
                        }
                        if (error.message.includes('not connected')) {
                            throw new McpError(ErrorCode.InternalError, 'Unity Editor connection was lost during command execution. Please verify the connection and try again.');
                        }
                    }
                    throw new McpError(ErrorCode.InternalError, `Failed to execute command: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
            case 'get_logs': {
                try {
                    const options = {
                        types: args?.types,
                        count: args?.count,
                        fields: args?.fields,
                        messageContains: args?.messageContains,
                        stackTraceContains: args?.stackTraceContains,
                        timestampAfter: args?.timestampAfter,
                        timestampBefore: args?.timestampBefore
                    };
                    const logs = wsHandler.getLogEntries(options);
                    return {
                        content: [{
                                type: 'text',
                                text: JSON.stringify(logs, null, 2)
                            }]
                    };
                }
                catch (error) {
                    throw new McpError(ErrorCode.InternalError, `Failed to retrieve logs: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
    }
    // Utility function to handle makeUnityRequest with retry logic
    async function makeUnityRequestWithRetry(requestFn, timeoutMs = 120000, // Increased default to 120 seconds
    maxRetries = 2) {
        let lastError = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                console.error(`[Unity MCP] Making request attempt ${attempt + 1}/${maxRetries + 1}`);
                // Return the promise directly without a separate timeout race
                // This allows the underlying request to use its own timeout
                return await requestFn();
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                console.error(`[Unity MCP] Request attempt ${attempt + 1} failed: ${lastError.message}`);
                if (attempt < maxRetries) {
                    console.error(`[Unity MCP] Waiting before retry...`);
                    // Wait before retrying
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }
        console.error(`[Unity MCP] All ${maxRetries + 1} request attempts failed`);
        throw lastError || new Error('Request failed after retries');
    }
    // Clean up resources when server is closing
    return {
        cleanup: () => {
            // Clear command processor interval
            if (commandProcessorInterval) {
                clearInterval(commandProcessorInterval);
                commandProcessorInterval = null;
            }
            // Reject any pending commands
            if (commandBuffer.length > 0) {
                console.error(`[Unity MCP] Rejecting ${commandBuffer.length} buffered commands due to shutdown`);
                for (const cmd of commandBuffer) {
                    cmd.reject(new McpError(ErrorCode.InternalError, 'Server is shutting down, command aborted'));
                }
                commandBuffer.length = 0;
            }
        }
    };
}

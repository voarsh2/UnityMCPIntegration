import { z } from 'zod';
import { WebSocketHandler } from './websocketHandler.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

export function registerTools(server: Server, wsHandler: WebSocketHandler) {
  // List all available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
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
        description: 'Execute C# code directly in the Unity Editor - code is executed immediately in the editor context, not as a MonoBehaviour script',
        category: 'Editor Control',
        tags: ['unity', 'editor', 'command', 'c#'],
        inputSchema: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description: 'Raw C# code to execute immediately in the Unity Editor. DO NOT include namespace declarations, class definitions or Start/Update methods. Write code that executes directly like a function body. The following namespaces are automatically available: UnityEngine, UnityEditor, System, System.Linq, System.Collections, and System.Collections.Generic. The code should return a value if you want to get results back.',
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
          properties: {
            requestEditorState: {
              type: 'boolean',
              description: 'Whether to request fresh editor state from Unity',
              default: false
            }
          },
          additionalProperties: false
        },
        returns: {
          type: 'object',
          description: 'Returns connection status information'
        }
      }
    ],
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Special case for verify_connection which should work even if not connected
    if (name === 'verify_connection') {
      try {
        const isConnected = wsHandler.isConnected();
        
        // Optionally request a fresh editor state
        if (args?.requestEditorState === true && isConnected) {
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
      } catch (error) {
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

    // For all other tools, verify connection first
    if (!wsHandler.isConnected()) {
      throw new McpError(
        ErrorCode.InternalError,
        'Unity Editor is not connected. Please first verify the connection using the verify_connection tool, ' +
        'and ensure the Unity Editor is running with the MCP plugin and that the WebSocket connection is established.'
      );
    }

    switch (name) {
      case 'get_current_scene_info': {
        try {
          const detailLevel = (args?.detailLevel as string) || 'RootObjectsOnly';
          
          // Send request to Unity and wait for response
          const sceneInfo = await wsHandler.requestSceneInfo(detailLevel);
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(sceneInfo, null, 2)
            }]
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to get scene info: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }
      
      case 'get_game_objects_info': {
        try {
          if (!args?.instanceIDs || !Array.isArray(args.instanceIDs)) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'instanceIDs array is required'
            );
          }
          
          const instanceIDs = args.instanceIDs;
          const detailLevel = (args?.detailLevel as string) || 'IncludeComponents';
          
          // Send request to Unity and wait for response
          const gameObjectsInfo = await wsHandler.requestGameObjectsInfo(instanceIDs, detailLevel);
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(gameObjectsInfo, null, 2)
            }]
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to get GameObject info: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      case 'execute_editor_command': {
        try {
          if (!args?.code) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'The code parameter is required'
            );
          }

          const startTime = Date.now();
          const result = await wsHandler.executeEditorCommand(args.code as string);
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
        } catch (error) {
          if (error instanceof Error) {
            if (error.message.includes('timed out')) {
              throw new McpError(
                ErrorCode.InternalError,
                'Command execution timed out. This may indicate a long-running operation or an issue with the Unity Editor.'
              );
            }
            
            if (error.message.includes('NullReferenceException')) {
              throw new McpError(
                ErrorCode.InvalidParams,
                'The code attempted to access a null object. Please check that all GameObject references exist.'
              );
            }

            if (error.message.includes('not connected')) {
              throw new McpError(
                ErrorCode.InternalError,
                'Unity Editor connection was lost during command execution. Please verify the connection and try again.'
              );
            }
          }

          throw new McpError(
            ErrorCode.InternalError,
            `Failed to execute command: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      case 'get_logs': {
        try {
          const options = {
            types: args?.types as string[] | undefined,
            count: args?.count as number | undefined,
            fields: args?.fields as string[] | undefined,
            messageContains: args?.messageContains as string | undefined,
            stackTraceContains: args?.stackTraceContains as string | undefined,
            timestampAfter: args?.timestampAfter as string | undefined,
            timestampBefore: args?.timestampBefore as string | undefined
          };
          
          const logs = wsHandler.getLogEntries(options);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify(logs, null, 2)
            }]
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to retrieve logs: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${name}`
        );
    }
  });
}
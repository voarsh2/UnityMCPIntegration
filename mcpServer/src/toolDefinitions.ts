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
        name: 'get_editor_state',
        description: 'Retrieve the current state of the Unity Editor, including active GameObjects, scene hierarchy, and project structure',
        category: 'Editor State',
        tags: ['unity', 'editor', 'state'],
        inputSchema: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              enum: ['Raw', 'scripts_only', 'no_scripts'],
              description: 'Specify the output format',
              default: 'Raw'
            }
          },
          additionalProperties: false
        },
        returns: {
          type: 'object',
          description: 'Returns a JSON object containing the editor state information'
        },
      },
      {
        name: 'execute_editor_command',
        description: 'Execute C# code within the Unity Editor',
        category: 'Editor Control',
        tags: ['unity', 'editor', 'command', 'c#'],
        inputSchema: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description: 'C# code to execute in the Unity Editor context. The code has access to all UnityEditor and UnityEngine APIs.',
              minLength: 1
            }
          },
          required: ['code'],
          additionalProperties: false
        },
        returns: {
          type: 'object',
          description: 'Returns the execution result and execution time'
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
        name: 'find_game_objects',
        description: 'Find GameObjects in the current scene by name, tag, or component',
        category: 'Editor Control',
        tags: ['unity', 'editor', 'gameobjects'],
        inputSchema: {
          type: 'object',
          properties: {
            nameContains: {
              type: 'string',
              description: 'Filter GameObjects by name (case-sensitive)'
            },
            tag: {
              type: 'string',
              description: 'Filter GameObjects by tag'
            },
            componentType: {
              type: 'string',
              description: 'Filter GameObjects by component type'
            }
          },
          additionalProperties: false
        },
        returns: {
          type: 'object',
          description: 'Returns a list of matching GameObjects'
        }
      }
    ],
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!wsHandler.isConnected()) {
      throw new McpError(
        ErrorCode.InternalError,
        'Unity Editor is not connected. Please ensure the Unity Editor is running with the MCP plugin.'
      );
    }

    const { name, arguments: args } = request.params;

    switch (name) {
      case 'get_editor_state': {
        try {
          const format = args?.format as string || 'Raw';
          const editorState = wsHandler.getEditorState();
          let responseData: any;

          switch (format) {
            case 'Raw':
              responseData = editorState;
              break;
            case 'scripts_only':
              responseData = editorState.projectStructure.scripts || [];
              break;
            case 'no_scripts': {
              const { projectStructure, ...stateWithoutScripts } = {...editorState};
              const { scripts, ...otherStructure } = {...projectStructure};
              responseData = {
                ...stateWithoutScripts,
                projectStructure: otherStructure
              };
              break;
            }
            default:
              throw new McpError(
                ErrorCode.InvalidParams,
                `Invalid format: ${format}. Valid formats are: Raw, scripts_only, no_scripts`
              );
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify(responseData, null, 2)
            }]
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to process editor state: ${error instanceof Error ? error.message : 'Unknown error'}`
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

      case 'find_game_objects': {
        try {
          const nameContains = args?.nameContains as string | undefined;
          const tag = args?.tag as string | undefined;
          const componentType = args?.componentType as string | undefined;

          // Construct C# code for finding GameObjects based on provided filters
          let findCode = 'var results = new List<GameObject>();\n';
          
          if (tag) {
            findCode += `var taggedObjects = GameObject.FindGameObjectsWithTag("${tag}");\n`;
            findCode += 'results.AddRange(taggedObjects);\n';
          } else {
            findCode += 'var allObjects = UnityEngine.Object.FindObjectsOfType<GameObject>();\n';
            findCode += 'results.AddRange(allObjects);\n';
          }

          if (nameContains) {
            findCode += `results = results.Where(go => go.name.Contains("${nameContains}")).ToList();\n`;
          }

          if (componentType) {
            findCode += `results = results.Where(go => go.GetComponent("${componentType}") != null).ToList();\n`;
          }

          findCode += 'return results.Select(go => go.name).ToArray();';

          // Execute the search code
          const result = await wsHandler.executeEditorCommand(`
            using System.Linq;
            using System.Collections.Generic;
            using UnityEngine;
            
            ${findCode}
          `);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                gameObjects: result,
                count: Array.isArray(result) ? result.length : 0
              }, null, 2)
            }]
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to find GameObjects: ${error instanceof Error ? error.message : 'Unknown error'}`
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
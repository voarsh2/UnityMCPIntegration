using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Plugins.GamePilot.Editor.MCP
{
    public class MCPMessageHandler
    {
        private readonly MCPDataCollector dataCollector;
        private readonly MCPCodeExecutor codeExecutor;
        private readonly MCPMessageSender messageSender;
        
        public MCPMessageHandler(MCPDataCollector dataCollector, MCPMessageSender messageSender)
        {
            this.dataCollector = dataCollector ?? throw new ArgumentNullException(nameof(dataCollector));
            this.messageSender = messageSender ?? throw new ArgumentNullException(nameof(messageSender));
            this.codeExecutor = new MCPCodeExecutor();
        }
        
        public async void HandleMessage(string messageJson)
        {
            if (string.IsNullOrEmpty(messageJson)) return;
            
            try
            {
                Debug.Log($"[MCP] Received message: {messageJson}");
                var message = JsonConvert.DeserializeObject<MCPMessage>(messageJson);
                if (message == null) return;
                
                switch (message.Type)
                {
                    case "selectGameObject":
                        await HandleSelectGameObjectAsync(message.Data);
                        break;
                    
                    case "togglePlayMode":
                        await HandleTogglePlayModeAsync();
                        break;
                    
                    case "executeCommand":
                        await HandleExecuteCommandAsync(message.Data);
                        break;
                    
                    case "ping":
                        await HandlePingAsync(message.Data);
                        break;
                    
                    case "getEditorState":
                        await HandleGetEditorStateAsync(message.Data);
                        break;
                        
                    case "getLogs":
                        await HandleGetLogsAsync(message.Data);
                        break;
                        
                    case "getFileContent":
                        await HandleGetFileContentAsync(message.Data);
                        break;
                        
                    case "getGameObjectDetails":
                        await HandleGetGameObjectDetailsAsync(message.Data);
                        break;
                        
                    default:
                        Debug.LogWarning($"[MCP] Unknown message type: {message.Type}");
                        break;
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error handling message: {ex.Message}\nMessage: {messageJson}");
            }
        }
        
        private async Task HandleSelectGameObjectAsync(JToken data)
        {
            try
            {
                string objectPath = data["path"]?.ToString();
                string requestId = data["requestId"]?.ToString();
                
                if (string.IsNullOrEmpty(objectPath)) return;
                
                var obj = GameObject.Find(objectPath);
                if (obj != null)
                {
                    Selection.activeGameObject = obj;
                    Debug.Log($"[MCP] Selected GameObject: {objectPath}");
                    
                    // If requestId was provided, send back object details
                    if (!string.IsNullOrEmpty(requestId))
                    {
                        await messageSender.SendGameObjectDetailsAsync(requestId, obj);
                    }
                }
                else
                {
                    Debug.LogWarning($"[MCP] GameObject not found: {objectPath}");
                    
                    if (!string.IsNullOrEmpty(requestId))
                    {
                        await messageSender.SendErrorMessageAsync("OBJECT_NOT_FOUND", $"GameObject not found: {objectPath}");
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error selecting GameObject: {ex.Message}");
            }
        }
        
        private async Task HandleTogglePlayModeAsync()
        {
            try
            {
                EditorApplication.isPlaying = !EditorApplication.isPlaying;
                Debug.Log($"[MCP] Toggled play mode to: {EditorApplication.isPlaying}");
                
                // Send updated editor state after toggling play mode
                var editorState = dataCollector.GetEditorState();
                await messageSender.SendEditorStateAsync(editorState);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error toggling play mode: {ex.Message}");
            }
        }
        
        private async Task HandleExecuteCommandAsync(JToken data)
        {
            try
            {
                string commandId = data["commandId"]?.ToString() ?? Guid.NewGuid().ToString();
                string code = data["code"]?.ToString();
                
                if (string.IsNullOrEmpty(code))
                {
                    Debug.LogWarning("[MCP] Received empty code to execute");
                    await messageSender.SendErrorMessageAsync("EMPTY_CODE", "Received empty code to execute");
                    return;
                }
                
                Debug.Log($"[MCP] Executing command: {commandId}\n{code}");
                
                var result = codeExecutor.ExecuteCode(code);
                
                // Send back the results
                await messageSender.SendCommandResultAsync(
                    commandId,
                    result,
                    codeExecutor.GetLogs(),
                    codeExecutor.GetErrors(),
                    codeExecutor.GetWarnings()
                );
                
                Debug.Log($"[MCP] Command execution completed");
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error executing command: {ex.Message}");
            }
        }
        
        private async Task HandlePingAsync(JToken data)
        {
            try
            {
                string pingId = data["pingId"]?.ToString() ?? Guid.NewGuid().ToString();
                await messageSender.SendPingResponseAsync(pingId);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error handling ping: {ex.Message}");
            }
        }
        
        private async Task HandleGetEditorStateAsync(JToken data)
        {
            try
            {
                // Get current editor state
                var editorState = dataCollector.GetEditorState();
                // Send it to the server
                await messageSender.SendEditorStateAsync(editorState);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error getting editor state: {ex.Message}");
            }
        }
        
        private async Task HandleGetLogsAsync(JToken data)
        {
            try
            {
                string requestId = data["requestId"]?.ToString() ?? Guid.NewGuid().ToString();
                int count = data["count"]?.Value<int>() ?? 50;
                
                // Get logs from collector
                var logs = dataCollector.GetRecentLogs(count);
                
                // Send logs back to server
                await messageSender.SendGetLogsResponseAsync(requestId, logs);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error getting logs: {ex.Message}");
            }
        }
        
        private async Task HandleGetFileContentAsync(JToken data)
        {
            try
            {
                string requestId = data["requestId"]?.ToString() ?? Guid.NewGuid().ToString();
                string filePath = data["path"]?.ToString();
                
                if (string.IsNullOrEmpty(filePath))
                {
                    await messageSender.SendErrorMessageAsync("INVALID_PATH", "File path is empty or invalid");
                    return;
                }
                
                // Ensure path is within the project
                if (!filePath.StartsWith(Application.dataPath) && !filePath.StartsWith("Assets/"))
                {
                    // If path starts with "Assets/", convert to full path
                    if (filePath.StartsWith("Assets/"))
                    {
                        filePath = Path.Combine(Application.dataPath, filePath.Substring(7));
                    }
                    else
                    {
                        await messageSender.SendErrorMessageAsync("INVALID_PATH", "File path must be within the project");
                        return;
                    }
                }
                
                if (!File.Exists(filePath))
                {
                    await messageSender.SendFileContentAsync(requestId, filePath, null, false);
                    return;
                }
                
                string content = File.ReadAllText(filePath);
                await messageSender.SendFileContentAsync(requestId, filePath, content, true);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error getting file content: {ex.Message}");
            }
        }
        
        private async Task HandleGetGameObjectDetailsAsync(JToken data)
        {
            try
            {
                string requestId = data["requestId"]?.ToString() ?? Guid.NewGuid().ToString();
                string objectPath = data["path"]?.ToString();
                
                if (string.IsNullOrEmpty(objectPath))
                {
                    // If no path specified, use current selection
                    var selectedObject = Selection.activeGameObject;
                    if (selectedObject != null)
                    {
                        await messageSender.SendGameObjectDetailsAsync(requestId, selectedObject);
                    }
                    else
                    {
                        await messageSender.SendErrorMessageAsync("NO_SELECTION", "No GameObject is selected");
                    }
                }
                else
                {
                    // Find by path
                    var obj = GameObject.Find(objectPath);
                    if (obj != null)
                    {
                        await messageSender.SendGameObjectDetailsAsync(requestId, obj);
                    }
                    else
                    {
                        await messageSender.SendErrorMessageAsync("OBJECT_NOT_FOUND", $"GameObject not found: {objectPath}");
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error getting GameObject details: {ex.Message}");
            }
        }
    }
    
    internal class MCPMessage
    {
        [JsonProperty("type")]
        public string Type { get; set; }
        
        [JsonProperty("data")]
        public JToken Data { get; set; }
    }
}

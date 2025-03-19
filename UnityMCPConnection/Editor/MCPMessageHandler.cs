using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System.Linq;

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
                    
                    case "executeEditorCommand": // Changed from "executeCommand" to match new server message type
                        await HandleExecuteCommandAsync(message.Data);
                        break;
                    
                    case "getEditorState":
                    case "requestEditorState": // Added new message type from server
                        await HandleGetEditorStateAsync(message.Data);
                        break;
                        
                    case "getLogs":
                        await HandleGetLogsAsync(message.Data);
                        break;
                        
                    case "handshake": // Added to handle server handshake message
                        await HandleHandshakeAsync(message.Data);
                        break;
                        
                    case "getSceneInfo":
                        await HandleGetSceneInfoAsync(message.Data);
                        break;
                        
                    case "getGameObjectsInfo":
                        await HandleGetGameObjectsInfoAsync(message.Data);
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
        
        // Add a new handler for handshake messages
        private async Task HandleHandshakeAsync(JToken data)
        {
            try
            {
                string message = data["message"]?.ToString() ?? "Server connected";
                Debug.Log($"[MCP] Handshake received: {message}");
                
                // Send editor state in response to handshake to establish connection
                var editorState = dataCollector.GetEditorState();
                await messageSender.SendEditorStateAsync(editorState);
                
                // disable periodic updates after handshake
               // MCPManager.EnablePeriodicUpdates(false);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error handling handshake: {ex.Message}");
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
                // Support both old and new parameter naming
                string commandId = data["commandId"]?.ToString() ?? data["id"]?.ToString() ?? Guid.NewGuid().ToString();
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
        
        private async Task HandleGetSceneInfoAsync(JToken data)
        {
            try
            {
                string requestId = data["requestId"]?.ToString() ?? Guid.NewGuid().ToString();
                string detailLevelStr = data["detailLevel"]?.ToString() ?? "RootObjectsOnly";
                
                // Parse the detail level
                SceneInfoDetail detailLevel;
                if (!Enum.TryParse(detailLevelStr, true, out detailLevel))
                {
                    detailLevel = SceneInfoDetail.RootObjectsOnly;
                }
                
                // Get scene info
                var sceneInfo = dataCollector.GetCurrentSceneInfo(detailLevel);
                
                // Send it to the server
                await messageSender.SendSceneInfoAsync(requestId, sceneInfo);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error handling getSceneInfo: {ex.Message}");
                await messageSender.SendErrorMessageAsync("SCENE_INFO_ERROR", ex.Message);
            }
        }
        
        private async Task HandleGetGameObjectsInfoAsync(JToken data)
        {
            try
            {
                string requestId = data["requestId"]?.ToString() ?? Guid.NewGuid().ToString();
                string detailLevelStr = data["detailLevel"]?.ToString() ?? "BasicInfo";
                
                // Get the list of instance IDs
                int[] instanceIDs;
                if (data["instanceIDs"] != null && data["instanceIDs"].Type == JTokenType.Array)
                {
                    instanceIDs = data["instanceIDs"].ToObject<int[]>();
                }
                else
                {
                    await messageSender.SendErrorMessageAsync("INVALID_PARAMS", "instanceIDs array is required");
                    return;
                }
                
                // Parse the detail level
                GameObjectInfoDetail detailLevel;
                if (!Enum.TryParse(detailLevelStr, true, out detailLevel))
                {
                    detailLevel = GameObjectInfoDetail.BasicInfo;
                }
                
                // Get game object details
                var gameObjectDetails = dataCollector.GetGameObjectsInfo(instanceIDs, detailLevel);
                
                // Send to server
                await messageSender.SendGameObjectsDetailsAsync(requestId, gameObjectDetails);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error handling getGameObjectsInfo: {ex.Message}");
                await messageSender.SendErrorMessageAsync("GAME_OBJECT_INFO_ERROR", ex.Message);
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

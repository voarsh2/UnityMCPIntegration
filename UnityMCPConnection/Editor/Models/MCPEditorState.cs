using System;
using System.Collections.Generic;
using Newtonsoft.Json;

namespace Plugins.GamePilot.Editor.MCP
{
    [Serializable]
    public class MCPEditorState
    {
        [JsonProperty("activeGameObjects")]
        public string[] ActiveGameObjects { get; set; } = new string[0];
        
        [JsonProperty("selectedObjects")]
        public string[] SelectedObjects { get; set; } = new string[0];
        
        [JsonProperty("playModeState")]
        public string PlayModeState { get; set; } = "Stopped";
        
        [JsonProperty("sceneHierarchy")]
        public List<MCPGameObjectInfo> SceneHierarchy { get; set; } = new List<MCPGameObjectInfo>();
        
        [JsonProperty("projectStructure")]
        public MCPProjectStructure ProjectStructure { get; set; } = new MCPProjectStructure();
        
        [JsonProperty("timestamp")]
        public DateTime Timestamp { get; set; } = DateTime.UtcNow;
    }
    
    [Serializable]
    public class MCPGameObjectInfo
    {
        [JsonProperty("name")]
        public string Name { get; set; }
        
        [JsonProperty("path")]
        public string Path { get; set; }
        
        [JsonProperty("components")]
        public string[] Components { get; set; } = new string[0];
        
        [JsonProperty("children")]
        public List<MCPGameObjectInfo> Children { get; set; } = new List<MCPGameObjectInfo>();
        
        [JsonProperty("active")]
        public bool Active { get; set; } = true;
        
        [JsonProperty("layer")]
        public int Layer { get; set; }
        
        [JsonProperty("tag")]
        public string Tag { get; set; }
    }
    
    [Serializable]
    public class MCPProjectStructure
    {
        [JsonProperty("scenes")]
        public string[] Scenes { get; set; } = new string[0];
        
        [JsonProperty("prefabs")]
        public string[] Prefabs { get; set; } = new string[0];
        
        [JsonProperty("scripts")]
        public string[] Scripts { get; set; } = new string[0];
        
        [JsonProperty("assets")]
        public string[] Assets { get; set; } = new string[0];
    }
    
    [Serializable]
    public class LogEntry
    {
        [JsonProperty("message")]
        public string Message { get; set; }
        
        [JsonProperty("stackTrace")]
        public string StackTrace { get; set; }
        
        [JsonProperty("type")]
        public UnityEngine.LogType Type { get; set; }
        
        [JsonProperty("timestamp")]
        public DateTime Timestamp { get; set; }
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Plugins.GamePilot.Editor.MCP
{
    public class MCPDataCollector : IDisposable
    {
        private readonly Queue<LogEntry> logBuffer = new Queue<LogEntry>();
        private readonly int maxLogBufferSize = 1000;
        private bool isLoggingEnabled = true;
        
        public MCPDataCollector()
        {
            // Start capturing logs
            Application.logMessageReceived += HandleLogMessage;
        }
        
        public void Dispose()
        {
            // Unsubscribe to prevent memory leaks
            Application.logMessageReceived -= HandleLogMessage;
        }
        
        private void HandleLogMessage(string message, string stackTrace, LogType type)
        {
            if (!isLoggingEnabled) return;
            
            var logEntry = new LogEntry
            {
                Message = message,
                StackTrace = stackTrace,
                Type = type,
                Timestamp = DateTime.UtcNow
            };
            
            lock (logBuffer)
            {
                logBuffer.Enqueue(logEntry);
                while (logBuffer.Count > maxLogBufferSize)
                {
                    logBuffer.Dequeue();
                }
            }
        }
        
        public bool IsLoggingEnabled
        {
            get => isLoggingEnabled;
            set
            {
                if (isLoggingEnabled == value) return;
                
                isLoggingEnabled = value;
                if (value)
                {
                    Application.logMessageReceived += HandleLogMessage;
                }
                else
                {
                    Application.logMessageReceived -= HandleLogMessage;
                }
            }
        }
        
        public LogEntry[] GetRecentLogs(int count = 50)
        {
            lock (logBuffer)
            {
                return logBuffer.Reverse().Take(count).Reverse().ToArray();
            }
        }
        
        public MCPEditorState GetEditorState()
        {
            var state = new MCPEditorState
            {
                ActiveGameObjects = GetActiveGameObjects(),
                SelectedObjects = GetSelectedObjects(),
                PlayModeState = EditorApplication.isPlaying ? "Playing" : "Stopped",
                SceneHierarchy = GetSceneHierarchy(),
                ProjectStructure = GetProjectStructure(),
                Timestamp = DateTime.UtcNow
            };
            
            return state;
        }
        
        private string[] GetActiveGameObjects()
        {
            try
            {
                var foundObjects = GameObject.FindObjectsByType<GameObject>(FindObjectsSortMode.None);
                return foundObjects.Where(o => o != null).Select(obj => obj.name).ToArray();
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error getting active GameObjects: {ex.Message}");
                return new string[0];
            }
        }
        
        private string[] GetSelectedObjects()
        {
            try
            {
                return Selection.gameObjects.Where(o => o != null).Select(obj => obj.name).ToArray();
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error getting selected objects: {ex.Message}");
                return new string[0];
            }
        }
        
        private List<MCPGameObjectInfo> GetSceneHierarchy()
        {
            var hierarchy = new List<MCPGameObjectInfo>();
            
            try
            {
                var scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
                if (scene.IsValid())
                {
                    var rootObjects = scene.GetRootGameObjects();
                    foreach (var root in rootObjects.Where(o => o != null))
                    {
                        hierarchy.Add(GetGameObjectHierarchy(root));
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error getting scene hierarchy: {ex.Message}");
            }
            
            return hierarchy;
        }
        
        private MCPGameObjectInfo GetGameObjectHierarchy(GameObject obj)
        {
            if (obj == null) return null;
            
            try
            {
                var info = new MCPGameObjectInfo
                {
                    Name = obj.name,
                    Path = GetGameObjectPath(obj),
                    Components = obj.GetComponents<Component>()
                        .Where(c => c != null)
                        .Select(c => c.GetType().Name)
                        .ToArray(),
                    Children = new List<MCPGameObjectInfo>(),
                    Active = obj.activeSelf,
                    Layer = obj.layer,
                    Tag = obj.tag
                };
                
                var transform = obj.transform;
                for (int i = 0; i < transform.childCount; i++)
                {
                    var childTransform = transform.GetChild(i);
                    if (childTransform != null && childTransform.gameObject != null)
                    {
                        var childInfo = GetGameObjectHierarchy(childTransform.gameObject);
                        if (childInfo != null)
                        {
                            info.Children.Add(childInfo);
                        }
                    }
                }
                
                return info;
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[MCP] Error processing GameObject {obj.name}: {ex.Message}");
                return new MCPGameObjectInfo { Name = obj.name, Path = GetGameObjectPath(obj) };
            }
        }
        
        private string GetGameObjectPath(GameObject obj)
        {
            if (obj == null) return string.Empty;
            
            try
            {
                string path = obj.name;
                Transform parent = obj.transform.parent;
                
                while (parent != null)
                {
                    path = parent.name + "/" + path;
                    parent = parent.parent;
                }
                
                return path;
            }
            catch (Exception)
            {
                return obj.name;
            }
        }
        
        private MCPProjectStructure GetProjectStructure()
        {
            return new MCPProjectStructure
            {
                Scenes = GetScenePaths(),
                Prefabs = GetPrefabPaths(),
                Scripts = GetScriptPaths(),
                Assets = GetAssetPaths()
            };
        }
        
        private string[] GetScenePaths()
        {
            try
            {
                return EditorBuildSettings.scenes.Select(s => s.path).ToArray();
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error getting scene paths: {ex.Message}");
                return new string[0];
            }
        }
        
        private string[] GetPrefabPaths()
        {
            try
            {
                var guids = AssetDatabase.FindAssets("t:Prefab");
                return guids.Select(guid => AssetDatabase.GUIDToAssetPath(guid)).ToArray();
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error getting prefab paths: {ex.Message}");
                return new string[0];
            }
        }
        
        private string[] GetScriptPaths()
        {
            try
            {
                var guids = AssetDatabase.FindAssets("t:Script");
                return guids.Select(guid => AssetDatabase.GUIDToAssetPath(guid)).ToArray();
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error getting script paths: {ex.Message}");
                return new string[0];
            }
        }
        
        private string[] GetAssetPaths()
        {
            try
            {
                // Get a sampling of important asset types
                var imageGuids = AssetDatabase.FindAssets("t:Texture2D t:Sprite");
                var audioGuids = AssetDatabase.FindAssets("t:AudioClip");
                var materialGuids = AssetDatabase.FindAssets("t:Material");
                
                var allGuids = new List<string>();
                allGuids.AddRange(imageGuids);
                allGuids.AddRange(audioGuids);
                allGuids.AddRange(materialGuids);
                
                return allGuids.Distinct().Select(guid => AssetDatabase.GUIDToAssetPath(guid)).ToArray();
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Error getting asset paths: {ex.Message}");
                return new string[0];
            }
        }
    }
}

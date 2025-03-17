using UnityEditor;
using UnityEditor.UIElements;
using UnityEngine;
using UnityEngine.UIElements;
using System;
using System.Collections.Generic;

namespace Plugins.GamePilot.Editor.MCP
{
    public class MCPDebugWindow : EditorWindow
    {
        [SerializeField]
        private VisualTreeAsset m_VisualTreeAsset = default;
        
        private Label connectionStatusLabel;
        private Button connectButton;
        private Button disconnectButton;
        private Toggle autoReconnectToggle;
        
        // Component logging toggles
        private Dictionary<string, Toggle> logToggles = new Dictionary<string, Toggle>();
        
        // Connection info labels
        private Label serverUrlLabel;
        private Label lastErrorLabel;
        private Label connectionTimeLabel;
        
        // Component status elements
        private VisualElement componentStatusContainer;
        
        // Statistics elements
        private Label messagesSentLabel;
        private Label messagesReceivedLabel;
        private Label reconnectAttemptsLabel;
        
        // Statistics counters
        private int messagesSent = 0;
        private int messagesReceived = 0;
        private int reconnectAttempts = 0;
        private DateTime? connectionStartTime = null;
        
        [MenuItem("Window/GamePilot/MCP Debug")]
        public static void ShowWindow()
        {
            MCPDebugWindow wnd = GetWindow<MCPDebugWindow>();
            wnd.titleContent = new GUIContent("MCP Debug");
            wnd.minSize = new Vector2(400, 500);
        }

        public void CreateGUI()
        {
            VisualElement root = rootVisualElement;
            
            // Load and clone the visual tree asset
            var visualTree = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(
                "Assets/Plugins/GamePilot/UnityMCP/UnityMCPlugin/Editor/UI/MCPDebugWindow.uxml");
            
            if (visualTree != null)
            {
                visualTree.CloneTree(root);
            }
            else
            {
                // Fallback if UXML is not found
                CreateFallbackUI(root);
                return;
            }
            
            // Load USS
            var styleSheet = AssetDatabase.LoadAssetAtPath<StyleSheet>(
                "Assets/Plugins/GamePilot/UnityMCP/UnityMCPlugin/Editor/UI/MCPDebugWindow.uss");
            
            if (styleSheet != null)
            {
                root.styleSheets.Add(styleSheet);
            }
            
            // Get UI elements
            connectionStatusLabel = root.Q<Label>("connection-status");
            connectButton = root.Q<Button>("connect-button");
            disconnectButton = root.Q<Button>("disconnect-button");
            autoReconnectToggle = root.Q<Toggle>("auto-reconnect-toggle");
            
            serverUrlLabel = root.Q<Label>("server-url-value");
            lastErrorLabel = root.Q<Label>("last-error-value");
            connectionTimeLabel = root.Q<Label>("connection-time-value");
            
            componentStatusContainer = root.Q<VisualElement>("component-status-container");
            
            messagesSentLabel = root.Q<Label>("messages-sent-value");
            messagesReceivedLabel = root.Q<Label>("messages-received-value");
            reconnectAttemptsLabel = root.Q<Label>("reconnect-attempts-value");
            
            // Setup UI events
            connectButton.clicked += OnConnectClicked;
            disconnectButton.clicked += OnDisconnectClicked;
            autoReconnectToggle.RegisterValueChangedCallback(OnAutoReconnectChanged);
            
            // Setup component logging toggles
            SetupComponentLoggingToggles(root);
            
            // Initialize UI with current state
            UpdateUIFromState();
            
            // Register for updates
            EditorApplication.update += OnEditorUpdate;
        }
        
        private void CreateFallbackUI(VisualElement root)
        {
            // Create a simple fallback UI if UXML fails to load
            root.Add(new Label("MCP Debug Window - UXML not found") { style = { fontSize = 16, marginBottom = 10 } });
            
            var connectButton = new Button(OnConnectClicked) { text = "Connect" };
            root.Add(connectButton);
            
            var disconnectButton = new Button(OnDisconnectClicked) { text = "Disconnect" };
            root.Add(disconnectButton);
            
            var autoReconnectToggle = new Toggle("Auto Reconnect");
            autoReconnectToggle.RegisterValueChangedCallback(OnAutoReconnectChanged);
            root.Add(autoReconnectToggle);
            
            connectionStatusLabel = new Label("Status: Not Connected");
            root.Add(connectionStatusLabel);
        }
        
        private void SetupComponentLoggingToggles(VisualElement root)
        {
            var loggingContainer = root.Q<VisualElement>("logging-container");
            
            // Global logging toggle
            var globalToggle = new Toggle("Enable All Logging");
            globalToggle.value = MCPLogger.GlobalLoggingEnabled;
            globalToggle.RegisterValueChangedCallback(evt => {
                MCPLogger.GlobalLoggingEnabled = evt.newValue;
                // Update all component toggles to show they're effectively disabled/enabled
                foreach (var componentName in MCPLogger.GetRegisteredComponents())
                {
                    if (logToggles.TryGetValue(componentName, out var toggle))
                    {
                        toggle.SetEnabled(evt.newValue);
                    }
                }
            });
            loggingContainer.Add(globalToggle);
            
            // Add a separator
            var separator = new VisualElement();
            separator.style.height = 1;
            separator.style.marginTop = 5;
            separator.style.marginBottom = 5;
            separator.style.backgroundColor = new Color(0.3f, 0.3f, 0.3f);
            loggingContainer.Add(separator);
            
            // Create toggles for standard components
            string[] standardComponents = {
                "MCPManager",
                "MCPConnectionManager",
                "MCPDataCollector",
                "MCPMessageHandler",
                "MCPCodeExecutor",
                "MCPMessageSender"
            };
            
            foreach (string componentName in standardComponents)
            {
                CreateLoggingToggle(loggingContainer, componentName, $"Enable {componentName} logging");
            }
            
            // Add any additional registered components not in our standard list
            foreach (var componentName in MCPLogger.GetRegisteredComponents())
            {
                if (!logToggles.ContainsKey(componentName))
                {
                    CreateLoggingToggle(loggingContainer, componentName, $"Enable {componentName} logging");
                }
            }
        }
        
        private void CreateLoggingToggle(VisualElement container, string componentName, string label)
        {
            var toggle = new Toggle(label);
            toggle.value = MCPLogger.GetComponentLoggingEnabled(componentName);
            toggle.SetEnabled(MCPLogger.GlobalLoggingEnabled);
            toggle.RegisterValueChangedCallback(evt => OnLoggingToggleChanged(componentName, evt.newValue));
            container.Add(toggle);
            logToggles[componentName] = toggle;
        }
        
        private void OnLoggingToggleChanged(string componentName, bool enabled)
        {
            MCPLogger.SetComponentLoggingEnabled(componentName, enabled);
        }
        
        private void OnConnectClicked()
        {
            // Initiate manual connection
            if (MCPManager.IsInitialized)
            {
                MCPManager.RetryConnection();
                connectionStartTime = DateTime.Now;
                UpdateUIFromState();
            }
            else
            {
                MCPManager.Initialize();
                connectionStartTime = DateTime.Now;
                UpdateUIFromState();
            }
        }
        
        private void OnDisconnectClicked()
        {
            if (MCPManager.IsInitialized)
            {
                MCPManager.Shutdown();
                connectionStartTime = null;
                UpdateUIFromState();
            }
        }
        
        private void OnAutoReconnectChanged(ChangeEvent<bool> evt)
        {
            if (MCPManager.IsInitialized)
            {
                MCPManager.EnableAutoReconnect(evt.newValue);
            }
        }
        
        private void OnEditorUpdate()
        {
            // Update connection status and statistics
            UpdateUIFromState();
        }
        
        private void UpdateUIFromState()
        {
            bool isInitialized = MCPManager.IsInitialized;
            bool isConnected = MCPManager.IsConnected;
            
            // Update status label
            if (!isInitialized)
            {
                connectionStatusLabel.text = "Not Initialized";
                connectionStatusLabel.RemoveFromClassList("status-connected");
                connectionStatusLabel.RemoveFromClassList("status-connecting");
                connectionStatusLabel.AddToClassList("status-disconnected");
            }
            else if (isConnected)
            {
                connectionStatusLabel.text = "Connected";
                connectionStatusLabel.RemoveFromClassList("status-disconnected");
                connectionStatusLabel.RemoveFromClassList("status-connecting");
                connectionStatusLabel.AddToClassList("status-connected");
            }
            else
            {
                connectionStatusLabel.text = "Disconnected";
                connectionStatusLabel.RemoveFromClassList("status-connected");
                connectionStatusLabel.RemoveFromClassList("status-connecting");
                connectionStatusLabel.AddToClassList("status-disconnected");
            }
            
            // Update button states
            connectButton.SetEnabled(!isConnected);
            disconnectButton.SetEnabled(isInitialized);
            
            // Update connection time if connected
            if (connectionStartTime.HasValue && isConnected)
            {
                TimeSpan duration = DateTime.Now - connectionStartTime.Value;
                connectionTimeLabel.text = $"{duration.Hours:00}:{duration.Minutes:00}:{duration.Seconds:00}";
            }
            else
            {
                connectionTimeLabel.text = "00:00:00";
            }
            
            // Update server URL
            serverUrlLabel.text = "ws://localhost:8080"; // Would come from your MCP connection
            
            // Update statistics if available
            if (isInitialized)
            {
                // Get connection statistics
                var connManager = GetConnectionManager();
                if (connManager != null)
                {
                    messagesSentLabel.text = connManager.MessagesSent.ToString();
                    messagesReceivedLabel.text = connManager.MessagesReceived.ToString();
                    reconnectAttemptsLabel.text = connManager.ReconnectAttempts.ToString();
                    lastErrorLabel.text = connManager.LastErrorMessage;
                }
                else
                {
                    messagesSentLabel.text = "0";
                    messagesReceivedLabel.text = "0";
                    reconnectAttemptsLabel.text = "0";
                    lastErrorLabel.text = string.Empty;
                }
            }
        }
        
        // Helper to access connection manager through reflection if needed
        private MCPConnectionManager GetConnectionManager()
        {
            if (!MCPManager.IsInitialized)
                return null;
                
            // Try to access the connection manager using reflection
            try
            {
                var managerType = typeof(MCPManager);
                var field = managerType.GetField("connectionManager", 
                    System.Reflection.BindingFlags.NonPublic | 
                    System.Reflection.BindingFlags.Static);
                    
                if (field != null)
                {
                    return field.GetValue(null) as MCPConnectionManager;
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"Error accessing connection manager: {ex.Message}");
            }
            
            return null;
        }
        
        // Register for MCP events to get real-time statistics
        private void RegisterMCPCallbacks()
        {
            // Example - in reality you would wire these up to your actual MCP events
            /*
            MCPManager.OnMessageSent += () => messagesSent++;
            MCPManager.OnMessageReceived += () => messagesReceived++;
            MCPManager.OnReconnectAttempt += () => reconnectAttempts++;
            */
        }
        
        private void OnDisable()
        {
            // Unregister from editor updates
            EditorApplication.update -= OnEditorUpdate;
            
            // Unregister from MCP callbacks if needed
            // MCPManager.UnregisterCallbacks();
        }
    }
}

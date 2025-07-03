using System;
using System.CodeDom.Compiler;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CSharp;
using UnityEngine;
using UnityEditor;

namespace Plugins.GamePilot.Editor.MCP
{
    public class MCPCodeExecutor
    {
        private readonly List<string> logs = new List<string>();
        private readonly List<string> errors = new List<string>();
        private readonly List<string> warnings = new List<string>();
        
        public object ExecuteCode(string code)
        {
            logs.Clear();
            errors.Clear();
            warnings.Clear();
            
            // Add log handler to capture output during execution
            Application.logMessageReceived += LogHandler;
            
            try
            {
                return ExecuteCommand(code);
            }
            catch (Exception ex)
            {
                string errorMessage = $"Code execution failed: {ex.Message}\n{ex.StackTrace}";
                Debug.LogError(errorMessage);
                errors.Add(errorMessage);
                return null;
            }
            finally
            {
                Application.logMessageReceived -= LogHandler;
                GC.Collect();
                GC.WaitForPendingFinalizers();
            }
        }

        private object ExecuteCommand(string code)
        {
            // The code should define a class called "McpScript" with a static method "Execute"
            // Less restrictive on what the code can contain (namespaces, classes, etc.)
            using (var provider = new CSharpCodeProvider())
            {
                var options = new CompilerParameters
                {
                    GenerateInMemory = true,
                    IncludeDebugInformation = true
                };
                
                // Add essential references
                AddEssentialReferences(options);
                
                // Compile the code as provided - with no wrapping
                var results = provider.CompileAssemblyFromSource(options, code);
                
                if (results.Errors.HasErrors)
                {
                    var errorMessages = new List<string>();
                    foreach (CompilerError error in results.Errors)
                    {
                        errorMessages.Add($"Line {error.Line}: {error.ErrorText}");
                    }
                    throw new Exception("Compilation failed: " + string.Join("\n", errorMessages));
                }

                // Get the compiled assembly and execute the code via the McpScript.Execute method
                var assembly = results.CompiledAssembly;
                var type = assembly.GetType("McpScript");
                if (type == null)
                {
                    throw new Exception("Could not find McpScript class in compiled assembly. Make sure your code defines a public class named 'McpScript'.");
                }
                
                var method = type.GetMethod("Execute");
                if (method == null)
                {
                    throw new Exception("Could not find Execute method in McpScript class. Make sure your code includes a public static method named 'Execute'.");
                }
                
                return method.Invoke(null, null);
            }
        }

        private void AddEssentialReferences(CompilerParameters options)
        {
            // Only add the most essential references to avoid conflicts
            try
            {
                // Use a HashSet to track added assemblies and avoid duplicates
                var addedAssemblies = new HashSet<string>();

                // Core Unity references (these are essential and shouldn't conflict)
                AddAssemblyIfNotExists(options, addedAssemblies, typeof(UnityEngine.Object).Assembly.Location); // UnityEngine
                AddAssemblyIfNotExists(options, addedAssemblies, typeof(UnityEditor.Editor).Assembly.Location); // UnityEditor

                // For system types, prefer mscorlib over netstandard to avoid conflicts
                // Only add mscorlib, NOT netstandard (this was causing the conflicts)
                AddAssemblyIfNotExists(options, addedAssemblies, typeof(System.Object).Assembly.Location); // mscorlib

                // Add System.Core for LINQ support, but check for conflicts
                var systemCore = AppDomain.CurrentDomain.GetAssemblies()
                    .FirstOrDefault(a => a.GetName().Name == "System.Core");
                if (systemCore != null && !string.IsNullOrEmpty(systemCore.Location))
                {
                    AddAssemblyIfNotExists(options, addedAssemblies, systemCore.Location);
                }

                // DO NOT add netstandard - this was causing the "predefined type defined multiple times" errors
                // The mscorlib reference above provides all the basic system types we need

                // Add essential Unity modules (but check for conflicts)
                AddUnityModuleSafe(options, addedAssemblies, "UnityEngine.CoreModule");
                AddUnityModuleSafe(options, addedAssemblies, "UnityEngine.PhysicsModule");
                AddUnityModuleSafe(options, addedAssemblies, "UnityEngine.UIModule");
                AddUnityModuleSafe(options, addedAssemblies, "UnityEngine.InputModule");
                AddUnityModuleSafe(options, addedAssemblies, "UnityEngine.AnimationModule");
                AddUnityModuleSafe(options, addedAssemblies, "UnityEngine.IMGUIModule");
                AddUnityModuleSafe(options, addedAssemblies, "UnityEngine.AudioModule");
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"Error adding assembly references: {ex.Message}");
            }
        }

        private void AddAssemblyIfNotExists(CompilerParameters options, HashSet<string> addedAssemblies, string assemblyLocation)
        {
            if (!string.IsNullOrEmpty(assemblyLocation) && !addedAssemblies.Contains(assemblyLocation))
            {
                options.ReferencedAssemblies.Add(assemblyLocation);
                addedAssemblies.Add(assemblyLocation);
            }
        }

        private void AddUnityModuleSafe(CompilerParameters options, HashSet<string> addedAssemblies, string moduleName)
        {
            try
            {
                var assembly = AppDomain.CurrentDomain.GetAssemblies()
                    .FirstOrDefault(a => a.GetName().Name == moduleName);

                if (assembly != null && !string.IsNullOrEmpty(assembly.Location))
                {
                    AddAssemblyIfNotExists(options, addedAssemblies, assembly.Location);
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"Failed to add Unity module {moduleName}: {ex.Message}");
            }
        }

        // Keep the old method for backward compatibility, but make it safer
        private void AddUnityModule(CompilerParameters options, string moduleName)
        {
            try
            {
                var assembly = AppDomain.CurrentDomain.GetAssemblies()
                    .FirstOrDefault(a => a.GetName().Name == moduleName);

                if (assembly != null && !string.IsNullOrEmpty(assembly.Location) &&
                    !options.ReferencedAssemblies.Contains(assembly.Location))
                {
                    options.ReferencedAssemblies.Add(assembly.Location);
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"Failed to add Unity module {moduleName}: {ex.Message}");
            }
        }
        
        private void LogHandler(string message, string stackTrace, LogType type)
        {
            switch (type)
            {
                case LogType.Log:
                    logs.Add(message);
                    break;
                case LogType.Warning:
                    warnings.Add(message);
                    break;
                case LogType.Error:
                case LogType.Exception:
                case LogType.Assert:
                    errors.Add($"{message}\n{stackTrace}");
                    break;
            }
        }
        
        public string[] GetLogs() => logs.ToArray();
        public string[] GetErrors() => errors.ToArray();
        public string[] GetWarnings() => warnings.ToArray();
    }
}

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
            // Create a method that wraps the code
            string wrappedCode = $@"
                using UnityEngine;
                using UnityEditor;
                using System;
                using System.Linq;
                using System.Collections;
                using System.Collections.Generic;

                public class CodeExecutor
                {{
                    public static object Execute()
                    {{
                        {code}
                        return ""Success"";
                    }}
                }}
            ";

            // Use a simpler set of compiler parameters to avoid conflicts
            var options = new CompilerParameters
            {
                GenerateInMemory = true,
                IncludeDebugInformation = true
            };
            
            // Add only essential references
            AddEssentialReferences(options);
            
            // Compile and execute
            using (var provider = new CSharpCodeProvider())
            {
                var results = provider.CompileAssemblyFromSource(options, wrappedCode);
                if (results.Errors.HasErrors)
                {
                    var errorMessages = new List<string>();
                    foreach (CompilerError error in results.Errors)
                    {
                        errorMessages.Add($"Line {error.Line}: {error.ErrorText}");
                    }
                    throw new Exception("Compilation failed: " + string.Join("\n", errorMessages));
                }

                // Get the compiled assembly and execute the code
                var assembly = results.CompiledAssembly;
                var type = assembly.GetType("CodeExecutor");
                if (type == null)
                {
                    throw new Exception("Could not find CodeExecutor type in compiled assembly");
                }
                
                var method = type.GetMethod("Execute");
                if (method == null)
                {
                    throw new Exception("Could not find Execute method in compiled assembly");
                }
                
                return method.Invoke(null, null);
            }
        }

        private void AddEssentialReferences(CompilerParameters options)
        {
            // Only add the most essential references to avoid conflicts
            try
            {
                // Core Unity and .NET references
                options.ReferencedAssemblies.Add(typeof(UnityEngine.Object).Assembly.Location); // UnityEngine
                options.ReferencedAssemblies.Add(typeof(UnityEditor.Editor).Assembly.Location); // UnityEditor
                options.ReferencedAssemblies.Add(typeof(System.Object).Assembly.Location); // mscorlib
                
                // Add System.Core for LINQ
                var systemCore = AppDomain.CurrentDomain.GetAssemblies()
                    .FirstOrDefault(a => a.GetName().Name == "System.Core");
                if (systemCore != null && !string.IsNullOrEmpty(systemCore.Location))
                {
                    options.ReferencedAssemblies.Add(systemCore.Location);
                }
                
                // Add netstandard reference
                var netStandardAssembly = AppDomain.CurrentDomain.GetAssemblies()
                    .FirstOrDefault(a => a.GetName().Name == "netstandard");
                if (netStandardAssembly != null && !string.IsNullOrEmpty(netStandardAssembly.Location))
                {
                    options.ReferencedAssemblies.Add(netStandardAssembly.Location);
                }
                
                // Add essential Unity modules
                AddUnityModule(options, "UnityEngine.CoreModule");
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"Error adding assembly references: {ex.Message}");
            }
        }

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
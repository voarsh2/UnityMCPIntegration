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
                // Create a method that wraps the code
                string wrappedCode = $@"
                    using UnityEngine;
                    using UnityEditor;
                    using System;
                    using System.Linq;
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
                
                // Use the C# compiler
                var options = new CompilerParameters
                {
                    GenerateInMemory = true
                };
                
                // Add references to necessary assemblies
                options.ReferencedAssemblies.Add(typeof(UnityEngine.Object).Assembly.Location);
                options.ReferencedAssemblies.Add(typeof(UnityEditor.Editor).Assembly.Location);
                options.ReferencedAssemblies.Add(typeof(System.Linq.Enumerable).Assembly.Location);
                options.ReferencedAssemblies.Add(typeof(object).Assembly.Location);
                
                // Add netstandard reference
                var netStandardAssembly = AppDomain.CurrentDomain.GetAssemblies()
                    .FirstOrDefault(a => a.GetName().Name == "netstandard");
                if (netStandardAssembly != null)
                {
                    options.ReferencedAssemblies.Add(netStandardAssembly.Location);
                }
                
                using (var provider = new CSharpCodeProvider())
                {
                    var results = provider.CompileAssemblyFromSource(options, wrappedCode);
                    
                    if (results.Errors.HasErrors)
                    {
                        foreach (CompilerError error in results.Errors)
                        {
                            errors.Add($"Line {error.Line}: {error.ErrorText}");
                        }
                        throw new Exception("Compilation failed: " + string.Join("\n", errors));
                    }
                    
                    var assembly = results.CompiledAssembly;
                    var type = assembly.GetType("CodeExecutor");
                    var method = type.GetMethod("Execute");
                    return method.Invoke(null, null);
                }
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

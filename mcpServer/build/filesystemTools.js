import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
// Schema definitions
const ReadFileArgsSchema = z.object({
    path: z.string().describe('Path to the file to read'),
});
const ReadMultipleFilesArgsSchema = z.object({
    paths: z.array(z.string()).describe('Array of file paths to read'),
});
const WriteFileArgsSchema = z.object({
    path: z.string().describe('Path to the file to write'),
    content: z.string().describe('Content to write to the file'),
});
const EditOperation = z.object({
    oldText: z.string().describe('Text to search for - must match exactly'),
    newText: z.string().describe('Text to replace with')
});
const EditFileArgsSchema = z.object({
    path: z.string().describe('Path to the file to edit'),
    edits: z.array(EditOperation).describe('Array of edit operations to apply'),
    dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format')
});
const ListDirectoryArgsSchema = z.object({
    path: z.string().describe('Path to the directory to list'),
});
const DirectoryTreeArgsSchema = z.object({
    path: z.string().describe('Path to the directory to get tree of'),
    maxDepth: z.number().optional().default(5).describe('Maximum depth to traverse'),
});
const SearchFilesArgsSchema = z.object({
    path: z.string().describe('Path to search from'),
    pattern: z.string().describe('Pattern to search for'),
    excludePatterns: z.array(z.string()).optional().default([]).describe('Patterns to exclude')
});
const GetFileInfoArgsSchema = z.object({
    path: z.string().describe('Path to the file to get info for'),
});
const FindAssetsByTypeArgsSchema = z.object({
    assetType: z.string().describe('Type of assets to find (e.g., "Material", "Prefab", "Scene")'),
    searchPath: z.string().optional().default("Assets").describe('Directory to search in')
});
const ListScriptsArgsSchema = z.object({
    path: z.string().optional().default("Assets/Scripts").describe('Path to look for scripts in'),
});
// Helper functions
async function validatePath(requestedPath, assetRootPath) {
    // Normalize path to handle both Windows and Unix-style paths
    const normalized = path.normalize(requestedPath);
    // Ensure path starts with Assets or ProjectSettings folder for safety
    const absolute = path.isAbsolute(normalized)
        ? normalized
        : path.join(assetRootPath, normalized);
    const resolvedPath = path.resolve(absolute);
    // Ensure we don't escape out of the Unity project folder
    if (!resolvedPath.startsWith(assetRootPath)) {
        throw new Error(`Access denied: Path ${requestedPath} is outside the Unity project directory`);
    }
    return resolvedPath;
}
async function getFileStats(filePath) {
    const stats = await fs.stat(filePath);
    return {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        permissions: stats.mode.toString(8).slice(-3),
    };
}
async function searchFiles(rootPath, pattern, excludePatterns = []) {
    const results = [];
    async function search(currentPath) {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            try {
                // Check if path matches any exclude pattern
                const relativePath = path.relative(rootPath, fullPath);
                const shouldExclude = excludePatterns.some(pattern => {
                    const globPattern = pattern.includes('*') ? pattern : `**/${pattern}/**`;
                    return minimatch(relativePath, globPattern, { dot: true });
                });
                if (shouldExclude) {
                    continue;
                }
                if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
                    results.push(fullPath);
                }
                if (entry.isDirectory()) {
                    await search(fullPath);
                }
            }
            catch (error) {
                // Skip invalid paths during search
                continue;
            }
        }
    }
    await search(rootPath);
    return results;
}
function normalizeLineEndings(text) {
    return text.replace(/\r\n/g, '\n');
}
function createUnifiedDiff(originalContent, newContent, filepath = 'file') {
    // Ensure consistent line endings for diff
    const normalizedOriginal = normalizeLineEndings(originalContent);
    const normalizedNew = normalizeLineEndings(newContent);
    return createTwoFilesPatch(filepath, filepath, normalizedOriginal, normalizedNew, 'original', 'modified');
}
async function applyFileEdits(filePath, edits, dryRun = false) {
    // Read file content and normalize line endings
    const content = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));
    // Apply edits sequentially
    let modifiedContent = content;
    for (const edit of edits) {
        const normalizedOld = normalizeLineEndings(edit.oldText);
        const normalizedNew = normalizeLineEndings(edit.newText);
        // If exact match exists, use it
        if (modifiedContent.includes(normalizedOld)) {
            modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
            continue;
        }
        // Otherwise, try line-by-line matching with flexibility for whitespace
        const oldLines = normalizedOld.split('\n');
        const contentLines = modifiedContent.split('\n');
        let matchFound = false;
        for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
            const potentialMatch = contentLines.slice(i, i + oldLines.length);
            // Compare lines with normalized whitespace
            const isMatch = oldLines.every((oldLine, j) => {
                const contentLine = potentialMatch[j];
                return oldLine.trim() === contentLine.trim();
            });
            if (isMatch) {
                // Preserve original indentation of first line
                const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
                const newLines = normalizedNew.split('\n').map((line, j) => {
                    if (j === 0)
                        return originalIndent + line.trimStart();
                    // For subsequent lines, try to preserve relative indentation
                    const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
                    const newIndent = line.match(/^\s*/)?.[0] || '';
                    if (oldIndent && newIndent) {
                        const relativeIndent = newIndent.length - oldIndent.length;
                        return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
                    }
                    return line;
                });
                contentLines.splice(i, oldLines.length, ...newLines);
                modifiedContent = contentLines.join('\n');
                matchFound = true;
                break;
            }
        }
        if (!matchFound) {
            throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
        }
    }
    // Create unified diff
    const diff = createUnifiedDiff(content, modifiedContent, filePath);
    // Format diff with appropriate number of backticks
    let numBackticks = 3;
    while (diff.includes('`'.repeat(numBackticks))) {
        numBackticks++;
    }
    const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;
    if (!dryRun) {
        await fs.writeFile(filePath, modifiedContent, 'utf-8');
    }
    return formattedDiff;
}
async function buildDirectoryTree(currentPath, assetRootPath, maxDepth = 5, currentDepth = 0) {
    if (currentDepth >= maxDepth) {
        return [{ name: "...", type: "directory" }];
    }
    const validPath = await validatePath(currentPath, assetRootPath);
    const entries = await fs.readdir(validPath, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
        const entryData = {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file'
        };
        if (entry.isDirectory()) {
            const subPath = path.join(currentPath, entry.name);
            entryData.children = await buildDirectoryTree(subPath, assetRootPath, maxDepth, currentDepth + 1);
        }
        result.push(entryData);
    }
    return result;
}
// Function to recognize Unity asset types based on file extension
function getUnityAssetType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    // Common Unity asset types
    const assetTypes = {
        '.unity': 'Scene',
        '.prefab': 'Prefab',
        '.mat': 'Material',
        '.fbx': 'Model',
        '.cs': 'Script',
        '.anim': 'Animation',
        '.controller': 'Animator Controller',
        '.asset': 'ScriptableObject',
        '.png': 'Texture',
        '.jpg': 'Texture',
        '.jpeg': 'Texture',
        '.tga': 'Texture',
        '.wav': 'Audio',
        '.mp3': 'Audio',
        '.ogg': 'Audio',
        '.shader': 'Shader',
        '.compute': 'Compute Shader',
        '.ttf': 'Font',
        '.otf': 'Font',
        '.physicMaterial': 'Physics Material',
        '.mask': 'Avatar Mask',
        '.playable': 'Playable',
        '.mixer': 'Audio Mixer',
        '.renderTexture': 'Render Texture',
        '.lighting': 'Lighting Settings',
        '.shadervariants': 'Shader Variants',
        '.spriteatlas': 'Sprite Atlas',
        '.guiskin': 'GUI Skin',
        '.flare': 'Flare',
        '.brush': 'Brush',
        '.overrideController': 'Animator Override Controller',
        '.preset': 'Preset',
        '.terrainlayer': 'Terrain Layer',
        '.signal': 'Signal',
        '.signalasset': 'Signal Asset',
        '.giparams': 'Global Illumination Parameters',
        '.cubemap': 'Cubemap',
    };
    return assetTypes[ext] || 'Other';
}
// Register filesystem tools with the MCP server
export function registerFilesystemTools(server, wsHandler) {
    // Determine project root path from environment variable or default to parent of Assets folder
    const projectPath = process.env.UNITY_PROJECT_PATH || path.resolve(process.cwd());
    // Get the original CallToolRequestSchema handler
    const originalCallToolHandler = server.handlers.get('mcp.callTool');
    // Create a modified CallToolRequestSchema handler that also handles filesystem tools
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
            switch (name) {
                case "read_file": {
                    const parsed = ReadFileArgsSchema.safeParse(args);
                    if (!parsed.success) {
                        return {
                            content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                            isError: true
                        };
                    }
                    const validPath = await validatePath(parsed.data.path, projectPath);
                    const content = await fs.readFile(validPath, "utf-8");
                    return {
                        content: [{ type: "text", text: content }],
                    };
                }
                case "read_multiple_files": {
                    const parsed = ReadMultipleFilesArgsSchema.safeParse(args);
                    if (!parsed.success) {
                        return {
                            content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                            isError: true
                        };
                    }
                    const results = await Promise.all(parsed.data.paths.map(async (filePath) => {
                        try {
                            const validPath = await validatePath(filePath, projectPath);
                            const content = await fs.readFile(validPath, "utf-8");
                            return `${filePath}:\n${content}\n`;
                        }
                        catch (error) {
                            const errorMessage = error instanceof Error ? error.message : String(error);
                            return `${filePath}: Error - ${errorMessage}`;
                        }
                    }));
                    return {
                        content: [{ type: "text", text: results.join("\n---\n") }],
                    };
                }
                case "write_file": {
                    const parsed = WriteFileArgsSchema.safeParse(args);
                    if (!parsed.success) {
                        return {
                            content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                            isError: true
                        };
                    }
                    const validPath = await validatePath(parsed.data.path, projectPath);
                    // Ensure directory exists
                    const dirPath = path.dirname(validPath);
                    await fs.mkdir(dirPath, { recursive: true });
                    await fs.writeFile(validPath, parsed.data.content, "utf-8");
                    return {
                        content: [{ type: "text", text: `Successfully wrote to ${parsed.data.path}` }],
                    };
                }
                case "edit_file": {
                    const parsed = EditFileArgsSchema.safeParse(args);
                    if (!parsed.success) {
                        return {
                            content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                            isError: true
                        };
                    }
                    const validPath = await validatePath(parsed.data.path, projectPath);
                    const result = await applyFileEdits(validPath, parsed.data.edits, parsed.data.dryRun);
                    return {
                        content: [{ type: "text", text: result }],
                    };
                }
                case "list_directory": {
                    const parsed = ListDirectoryArgsSchema.safeParse(args);
                    if (!parsed.success) {
                        return {
                            content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                            isError: true
                        };
                    }
                    const validPath = await validatePath(parsed.data.path, projectPath);
                    const entries = await fs.readdir(validPath, { withFileTypes: true });
                    const formatted = entries
                        .map((entry) => {
                        if (entry.isDirectory()) {
                            return `[DIR] ${entry.name}`;
                        }
                        else {
                            // For files, detect Unity asset type
                            const filePath = path.join(validPath, entry.name);
                            const assetType = getUnityAssetType(filePath);
                            return `[${assetType}] ${entry.name}`;
                        }
                    })
                        .join("\n");
                    return {
                        content: [{ type: "text", text: formatted }],
                    };
                }
                case "directory_tree": {
                    const parsed = DirectoryTreeArgsSchema.safeParse(args);
                    if (!parsed.success) {
                        return {
                            content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                            isError: true
                        };
                    }
                    const treeData = await buildDirectoryTree(parsed.data.path, projectPath, parsed.data.maxDepth);
                    return {
                        content: [{ type: "text", text: JSON.stringify(treeData, null, 2) }],
                    };
                }
                case "search_files": {
                    const parsed = SearchFilesArgsSchema.safeParse(args);
                    if (!parsed.success) {
                        return {
                            content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                            isError: true
                        };
                    }
                    const validPath = await validatePath(parsed.data.path, projectPath);
                    const results = await searchFiles(validPath, parsed.data.pattern, parsed.data.excludePatterns);
                    return {
                        content: [{
                                type: "text",
                                text: results.length > 0
                                    ? `Found ${results.length} results:\n${results.join("\n")}`
                                    : "No matches found"
                            }],
                    };
                }
                case "get_file_info": {
                    const parsed = GetFileInfoArgsSchema.safeParse(args);
                    if (!parsed.success) {
                        return {
                            content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                            isError: true
                        };
                    }
                    const validPath = await validatePath(parsed.data.path, projectPath);
                    const info = await getFileStats(validPath);
                    // Also get Unity-specific info if it's an asset file
                    const additionalInfo = {};
                    if (info.isFile) {
                        additionalInfo.assetType = getUnityAssetType(validPath);
                    }
                    const formattedInfo = Object.entries({ ...info, ...additionalInfo })
                        .map(([key, value]) => `${key}: ${value}`)
                        .join("\n");
                    return {
                        content: [{ type: "text", text: formattedInfo }],
                    };
                }
                case "find_assets_by_type": {
                    const parsed = FindAssetsByTypeArgsSchema.safeParse(args);
                    if (!parsed.success) {
                        return {
                            content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                            isError: true
                        };
                    }
                    const validPath = await validatePath(parsed.data.searchPath, projectPath);
                    const results = [];
                    const targetType = parsed.data.assetType.toLowerCase();
                    // Recursive function to search for assets
                    async function searchAssets(dir) {
                        const entries = await fs.readdir(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            const fullPath = path.join(dir, entry.name);
                            if (entry.isDirectory()) {
                                await searchAssets(fullPath);
                            }
                            else {
                                const assetType = getUnityAssetType(fullPath);
                                if (assetType.toLowerCase() === targetType) {
                                    results.push(fullPath);
                                }
                            }
                        }
                    }
                    await searchAssets(validPath);
                    return {
                        content: [{
                                type: "text",
                                text: results.length > 0
                                    ? `Found ${results.length} ${parsed.data.assetType} assets:\n${results.join("\n")}`
                                    : `No ${parsed.data.assetType} assets found`
                            }],
                    };
                }
                case "list_scripts": {
                    const parsed = ListScriptsArgsSchema.safeParse(args);
                    if (!parsed.success) {
                        return {
                            content: [{ type: "text", text: `Invalid arguments: ${parsed.error}` }],
                            isError: true
                        };
                    }
                    const validPath = await validatePath(parsed.data.path, projectPath);
                    const scripts = [];
                    // Recursive function to find C# scripts
                    async function findScripts(dir) {
                        const entries = await fs.readdir(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            const fullPath = path.join(dir, entry.name);
                            if (entry.isDirectory()) {
                                await findScripts(fullPath);
                            }
                            else if (path.extname(entry.name).toLowerCase() === '.cs') {
                                scripts.push({
                                    path: fullPath,
                                    name: entry.name
                                });
                            }
                        }
                    }
                    await findScripts(validPath);
                    const formattedScripts = scripts.map(s => `${s.name} (${s.path})`).join("\n");
                    return {
                        content: [{
                                type: "text",
                                text: scripts.length > 0
                                    ? `Found ${scripts.length} C# scripts:\n${formattedScripts}`
                                    : "No C# scripts found"
                            }],
                    };
                }
                default:
                    // If it's not one of our filesystem tools and there's an original handler, use it
                    if (originalCallToolHandler) {
                        return originalCallToolHandler(request);
                    }
                    return {
                        content: [{ type: "text", text: `Unknown tool: ${name}` }],
                        isError: true,
                    };
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: `Error: ${errorMessage}` }],
                isError: true,
            };
        }
    });
    // Update the ListToolsRequestSchema handler to add filesystem tools to the list
    const originalListToolsHandler = server.handlers.get('mcp.listTools');
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
        // Call the original handler if it exists
        const originalResponse = originalListToolsHandler ? await originalListToolsHandler(request) : { tools: [] };
        // Add the filesystem tools to the list
        const filesystemTools = [
            {
                name: "read_file",
                description: "Read the contents of a file from the Unity project. Paths are relative to the project's Assets folder unless specified as absolute.",
                inputSchema: zodToJsonSchema(ReadFileArgsSchema),
            },
            {
                name: "read_multiple_files",
                description: "Read the contents of multiple files from the Unity project simultaneously.",
                inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema),
            },
            {
                name: "write_file",
                description: "Create a new file or completely overwrite an existing file in the Unity project.",
                inputSchema: zodToJsonSchema(WriteFileArgsSchema),
            },
            {
                name: "edit_file",
                description: "Make precise edits to a text file in the Unity project. Returns a git-style diff showing changes.",
                inputSchema: zodToJsonSchema(EditFileArgsSchema),
            },
            {
                name: "list_directory",
                description: "Get a listing of all files and directories in a specified path in the Unity project.",
                inputSchema: zodToJsonSchema(ListDirectoryArgsSchema),
            },
            {
                name: "directory_tree",
                description: "Get a recursive tree view of files and directories in the Unity project as a JSON structure.",
                inputSchema: zodToJsonSchema(DirectoryTreeArgsSchema),
            },
            {
                name: "search_files",
                description: "Recursively search for files and directories matching a pattern in the Unity project.",
                inputSchema: zodToJsonSchema(SearchFilesArgsSchema),
            },
            {
                name: "get_file_info",
                description: "Retrieve detailed metadata about a file or directory in the Unity project.",
                inputSchema: zodToJsonSchema(GetFileInfoArgsSchema),
            },
            {
                name: "find_assets_by_type",
                description: "Find all Unity assets of a specified type (e.g., Material, Prefab, Script) in the project.",
                inputSchema: zodToJsonSchema(FindAssetsByTypeArgsSchema),
            },
            {
                name: "list_scripts",
                description: "List all C# script files in the project, useful for understanding the codebase structure.",
                inputSchema: zodToJsonSchema(ListScriptsArgsSchema),
            }
        ];
        originalResponse.tools = [...originalResponse.tools, ...filesystemTools];
        return originalResponse;
    });
}

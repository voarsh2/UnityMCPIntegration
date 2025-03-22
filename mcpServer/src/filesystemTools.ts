import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebSocketHandler } from './websocketHandler.js';
import fs from 'fs/promises';
import { Dirent } from 'fs'; // Import Dirent instead of DirEnt
import path from 'path';
import { createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';
import {
  ReadFileArgsSchema,
  ReadMultipleFilesArgsSchema,
  WriteFileArgsSchema,
  EditFileArgsSchema,
  ListDirectoryArgsSchema,
  DirectoryTreeArgsSchema,
  SearchFilesArgsSchema,
  GetFileInfoArgsSchema,
  FindAssetsByTypeArgsSchema
} from './toolDefinitions.js';

// Interface definitions
interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

interface TreeEntry {
  name: string;
  type: 'file' | 'directory';
  children?: TreeEntry[];
}

// Helper functions
async function validatePath(requestedPath: string, assetRootPath: string): Promise<string> {
  // If path is empty or just quotes, use the asset root path directly
  if (!requestedPath || requestedPath.trim() === '' || requestedPath.trim() === '""' || requestedPath.trim() === "''") {
    console.error(`[Unity MCP] Using asset root path: ${assetRootPath}`);
    return assetRootPath;
  }
  
  // Clean the path to remove any unexpected quotes or escape characters
  let cleanPath = requestedPath.replace(/['"\\]/g, '');
  
  // Handle empty path after cleaning
  if (!cleanPath || cleanPath.trim() === '') {
    return assetRootPath;
  }
  
  // Normalize path to handle both Windows and Unix-style paths
  const normalized = path.normalize(cleanPath);
  
  // Resolve the path (absolute or relative)
  let absolute = resolvePathToAssetRoot(normalized, assetRootPath);
  const resolvedPath = path.resolve(absolute);
  
  // Ensure we don't escape out of the Unity project folder
  validatePathSecurity(resolvedPath, assetRootPath, requestedPath);
  
  return resolvedPath;
}

function resolvePathToAssetRoot(pathToResolve: string, assetRootPath: string): string {
  if (path.isAbsolute(pathToResolve)) {
    console.error(`[Unity MCP] Absolute path requested: ${pathToResolve}`);
    
    // If the absolute path is outside the project, try alternative resolutions
    if (!pathToResolve.startsWith(assetRootPath)) {
      // Try 1: Treat as relative path
      const tryRelative = path.join(assetRootPath, pathToResolve);
      try {
        fs.access(tryRelative);
        console.error(`[Unity MCP] Treating as relative path: ${tryRelative}`);
        return tryRelative;
      } catch {
        // Try 2: Try to extract path relative to Assets if it contains "Assets"
        if (pathToResolve.includes('Assets')) {
          const assetsIndex = pathToResolve.indexOf('Assets');
          const relativePath = pathToResolve.substring(assetsIndex + 7); // +7 to skip "Assets/"
          const newPath = path.join(assetRootPath, relativePath);
          console.error(`[Unity MCP] Trying via Assets path: ${newPath}`);
          
          try {
            fs.access(newPath);
            return newPath;
          } catch { /* Use original if all else fails */ }
        }
      }
    }
    return pathToResolve;
  } else {
    // For relative paths, join with asset root path
    return path.join(assetRootPath, pathToResolve);
  }
}

function validatePathSecurity(resolvedPath: string, assetRootPath: string, requestedPath: string): void {
  if (!resolvedPath.startsWith(assetRootPath) && requestedPath.trim() !== '') {
    console.error(`[Unity MCP] Access denied: Path ${requestedPath} is outside the project directory`);
    console.error(`[Unity MCP] Resolved to: ${resolvedPath}`);
    console.error(`[Unity MCP] Expected to be within: ${assetRootPath}`);
    throw new Error(`Access denied: Path ${requestedPath} is outside the Unity project directory`);
  }
}

async function getFileStats(filePath: string): Promise<FileInfo> {
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

async function searchFiles(
  rootPath: string,
  pattern: string,
  excludePatterns: string[] = []
): Promise<string[]> {
  const results: string[] = [];

  async function search(currentPath: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      try {
        // Check if path matches any exclude pattern
        const relativePath = path.relative(rootPath, fullPath);
        if (isPathExcluded(relativePath, excludePatterns)) continue;

        if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
          results.push(fullPath);
        }

        if (entry.isDirectory()) {
          await search(fullPath);
        }
      } catch (error) {
        // Skip invalid paths during search
        continue;
      }
    }
  }

  await search(rootPath);
  return results;
}

function isPathExcluded(relativePath: string, excludePatterns: string[]): boolean {
  return excludePatterns.some(pattern => {
    const globPattern = pattern.includes('*') ? pattern : `**/${pattern}/**`;
    return minimatch(relativePath, globPattern, { dot: true });
  });
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function createUnifiedDiff(originalContent: string, newContent: string, filepath: string = 'file'): string {
  // Ensure consistent line endings for diff
  const normalizedOriginal = normalizeLineEndings(originalContent);
  const normalizedNew = normalizeLineEndings(newContent);

  return createTwoFilesPatch(
    filepath,
    filepath,
    normalizedOriginal,
    normalizedNew,
    'original',
    'modified'
  );
}

async function applyFileEdits(
  filePath: string,
  edits: Array<{oldText: string, newText: string}>,
  dryRun = false
): Promise<string> {
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

    // Try line-by-line matching with whitespace flexibility
    modifiedContent = applyFlexibleLineEdit(modifiedContent, normalizedOld, normalizedNew);
  }

  // Create unified diff
  const diff = createUnifiedDiff(content, modifiedContent, filePath);
  const formattedDiff = formatDiff(diff);

  if (!dryRun) {
    await fs.writeFile(filePath, modifiedContent, 'utf-8');
  }

  return formattedDiff;
}

function applyFlexibleLineEdit(content: string, oldText: string, newText: string): string {
  const oldLines = oldText.split('\n');
  const contentLines = content.split('\n');
  
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const potentialMatch = contentLines.slice(i, i + oldLines.length);

    // Compare lines with normalized whitespace
    const isMatch = oldLines.every((oldLine, j) => {
      const contentLine = potentialMatch[j];
      return oldLine.trim() === contentLine.trim();
    });

    if (isMatch) {
      // Preserve indentation
      const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
      const newLines = newText.split('\n').map((line, j) => {
        if (j === 0) return originalIndent + line.trimStart();
        
        const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
        const newIndent = line.match(/^\s*/)?.[0] || '';
        
        if (oldIndent && newIndent) {
          const relativeIndent = newIndent.length - oldIndent.length;
          return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
        }
        return line;
      });

      contentLines.splice(i, oldLines.length, ...newLines);
      return contentLines.join('\n');
    }
  }

  throw new Error(`Could not find exact match for edit:\n${oldText}`);
}

function formatDiff(diff: string): string {
  let numBackticks = 3;
  while (diff.includes('`'.repeat(numBackticks))) {
    numBackticks++;
  }
  return `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;
}

async function buildDirectoryTree(currentPath: string, assetRootPath: string, maxDepth: number = 5, currentDepth: number = 0): Promise<TreeEntry[]> {
  if (currentDepth >= maxDepth) {
    return [{ name: "...", type: "directory" }];
  }
  
  const validPath = await validatePath(currentPath, assetRootPath);
  const entries = await fs.readdir(validPath, { withFileTypes: true });
  const result: TreeEntry[] = [];

  for (const entry of entries) {
    const entryData: TreeEntry = {
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
function getUnityAssetType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  
  // Common Unity asset types
  const assetTypes: Record<string, string> = {
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

// Get file extensions for Unity asset types
function getFileExtensionsForType(type: string): string[] {
  type = type.toLowerCase();
  const extensionMap: Record<string, string[]> = {
    'scene': ['.unity'],
    'prefab': ['.prefab'],
    'material': ['.mat'],
    'script': ['.cs'],
    'model': ['.fbx', '.obj', '.blend', '.max', '.mb', '.ma'],
    'texture': ['.png', '.jpg', '.jpeg', '.tga', '.tif', '.tiff', '.psd', '.exr', '.hdr'],
    'audio': ['.wav', '.mp3', '.ogg', '.aiff', '.aif'],
    'animation': ['.anim'],
    'animator': ['.controller'],
    'shader': ['.shader', '.compute', '.cginc']
  };
  
  return extensionMap[type] || [];
}

// Handler function to process filesystem tools
export async function handleFilesystemTool(name: string, args: any, projectPath: string) {
  try {
    switch (name) {
      case "read_file": {
        const parsed = ReadFileArgsSchema.safeParse(args);
        if (!parsed.success) return invalidArgsResponse(parsed.error);
        
        const validPath = await validatePath(parsed.data.path, projectPath);
        const content = await fs.readFile(validPath, "utf-8");
        return { content: [{ type: "text", text: content }] };
      }

      case "read_multiple_files": {
        const parsed = ReadMultipleFilesArgsSchema.safeParse(args);
        if (!parsed.success) return invalidArgsResponse(parsed.error);
        
        const results = await Promise.all(
          parsed.data.paths.map(async (filePath: string) => {
            try {
              const validPath = await validatePath(filePath, projectPath);
              const content = await fs.readFile(validPath, "utf-8");
              return `${filePath}:\n${content}\n`;
            } catch (error) {
              return `${filePath}: Error - ${getErrorMessage(error)}`;
            }
          }),
        );
        return { content: [{ type: "text", text: results.join("\n---\n") }] };
      }

      case "write_file": {
        const parsed = WriteFileArgsSchema.safeParse(args);
        if (!parsed.success) return invalidArgsResponse(parsed.error);
        
        const validPath = await validatePath(parsed.data.path, projectPath);
        
        // Ensure directory exists
        const dirPath = path.dirname(validPath);
        await fs.mkdir(dirPath, { recursive: true });
        
        await fs.writeFile(validPath, parsed.data.content, "utf-8");
        return { 
          content: [{ type: "text", text: `Successfully wrote to ${parsed.data.path}` }]
        };
      }

      case "edit_file": {
        const parsed = EditFileArgsSchema.safeParse(args);
        if (!parsed.success) return invalidArgsResponse(parsed.error);
        
        const validPath = await validatePath(parsed.data.path, projectPath);
        const result = await applyFileEdits(validPath, parsed.data.edits, parsed.data.dryRun);
        return { content: [{ type: "text", text: result }] };
      }

      case "list_directory": {
        const parsed = ListDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) return invalidArgsResponse(parsed.error);
        
        const validPath = await validatePath(parsed.data.path, projectPath);
        const entries = await fs.readdir(validPath, { withFileTypes: true });
        const formatted = entries
          .map((entry) => formatDirectoryEntry(entry, validPath))
          .join("\n");
        return { content: [{ type: "text", text: formatted }] };
      }

      case "directory_tree": {
        const parsed = DirectoryTreeArgsSchema.safeParse(args);
        if (!parsed.success) return invalidArgsResponse(parsed.error);
        
        const treeData = await buildDirectoryTree(parsed.data.path, projectPath, parsed.data.maxDepth);
        return { content: [{ type: "text", text: JSON.stringify(treeData, null, 2) }] };
      }

      case "search_files": {
        const parsed = SearchFilesArgsSchema.safeParse(args);
        if (!parsed.success) return invalidArgsResponse(parsed.error);
        
        const validPath = await validatePath(parsed.data.path, projectPath);
        const results = await searchFiles(validPath, parsed.data.pattern, parsed.data.excludePatterns);
        return { 
          content: [{ 
            type: "text", 
            text: results.length > 0 
              ? `Found ${results.length} results:\n${results.join("\n")}` 
              : "No matches found" 
          }]
        };
      }

      case "get_file_info": {
        const parsed = GetFileInfoArgsSchema.safeParse(args);
        if (!parsed.success) return invalidArgsResponse(parsed.error);
        
        const validPath = await validatePath(parsed.data.path, projectPath);
        const info = await getFileStats(validPath);
        
        // Add Unity-specific info if it's an asset file
        const additionalInfo: Record<string, string> = {};
        if (info.isFile) {
          additionalInfo.assetType = getUnityAssetType(validPath);
        }
        
        const formattedInfo = Object.entries({ ...info, ...additionalInfo })
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n");
          
        return { content: [{ type: "text", text: formattedInfo }] };
      }

      case "find_assets_by_type": {
        const parsed = FindAssetsByTypeArgsSchema.safeParse(args);
        if (!parsed.success) return invalidArgsResponse(parsed.error);
        
        const assetType = parsed.data.assetType.replace(/['"]/g, '');
        const searchPath = parsed.data.searchPath.replace(/['"]/g, '');
        const maxDepth = parsed.data.maxDepth;
        
        console.error(`[Unity MCP] Finding assets of type "${assetType}" in path "${searchPath}" with maxDepth ${maxDepth}`);
        
        const validPath = await validatePath(searchPath, projectPath);
        const results = await findAssetsByType(assetType, validPath, maxDepth, projectPath);
        
        return {
          content: [{ 
            type: "text", 
            text: results.length > 0 
              ? `Found ${results.length} ${assetType} assets:\n${JSON.stringify(results, null, 2)}` 
              : `No "${assetType}" assets found in ${searchPath || "Assets"}` 
          }]
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${getErrorMessage(error)}` }],
      isError: true,
    };
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidArgsResponse(error: any) {
  return {
    content: [{ type: "text", text: `Invalid arguments: ${error}` }],
    isError: true
  };
}

// Fixed function to use proper Dirent type
function formatDirectoryEntry(entry: Dirent, basePath: string): string {
  if (entry.isDirectory()) {
    return `[DIR] ${entry.name}`;
  } else {
    // For files, detect Unity asset type
    const filePath = path.join(basePath, entry.name);
    const assetType = getUnityAssetType(filePath);
    return `[${assetType}] ${entry.name}`;
  }
}

async function findAssetsByType(
  assetType: string, 
  searchPath: string, 
  maxDepth: number, 
  projectPath: string
): Promise<Array<{path: string, name: string, type: string}>> {
  const results: Array<{path: string, name: string, type: string}> = [];
  const extensions = getFileExtensionsForType(assetType);
  
  async function searchAssets(dir: string, currentDepth: number = 1) {
    // Stop recursion if we've reached the maximum depth
    if (maxDepth !== -1 && currentDepth > maxDepth) {
      return;
    }
    
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(projectPath, fullPath);
        
        if (entry.isDirectory()) {
          // Recursively search subdirectories
          await searchAssets(fullPath, currentDepth + 1);
        } else {
          // Check if the file matches the requested asset type
          const ext = path.extname(entry.name).toLowerCase();
          
          if (extensions.length === 0) {
            // If no extensions specified, match by Unity asset type
            const fileAssetType = getUnityAssetType(fullPath);
            if (fileAssetType.toLowerCase() === assetType.toLowerCase()) {
              results.push({
                path: relativePath,
                name: entry.name,
                type: fileAssetType
              });
            }
          } else if (extensions.includes(ext)) {
            // Match by extension
            results.push({
              path: relativePath,
              name: entry.name,
              type: assetType
            });
          }
        }
      }
    } catch (error) {
      console.error(`Error accessing directory ${dir}:`, error);
    }
  }
  
  await searchAssets(searchPath);
  return results;
}

// This function is deprecated and now just a stub
export function registerFilesystemTools(server: Server, wsHandler: WebSocketHandler) {
  console.log("Filesystem tools are now registered in toolDefinitions.ts");
}

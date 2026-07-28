import fs from 'fs/promises';
import path from 'path';

const MANIFEST_FILENAME = 'console.tools.json';

/** Schema validation for a single custom tool entry. */
function validateToolEntry(tool, index) {
  const errors = [];
  if (!tool || typeof tool !== 'object') {
    errors.push(`entry ${index}: must be an object`);
    return { valid: false, errors };
  }
  if (!tool.name || typeof tool.name !== 'string' || !/^[a-zA-Z_]\w*$/.test(tool.name)) {
    errors.push(`entry ${index}: "name" is required and must be a valid identifier (e.g., "deploy_to_vercel")`);
  }
  if (!tool.description || typeof tool.description !== 'string') {
    errors.push(`entry ${index} ("${tool.name || '?'}"): "description" is required`);
  }
  if (!tool.command || typeof tool.command !== 'string') {
    errors.push(`entry ${index} ("${tool.name || '?'}"): "command" is required`);
  }
  if (tool.risky !== undefined && typeof tool.risky !== 'boolean') {
    errors.push(`entry ${index} ("${tool.name}"): "risky" must be a boolean if provided`);
  }
  if (tool.args !== undefined) {
    if (typeof tool.args !== 'object' || Array.isArray(tool.args)) {
      errors.push(`entry ${index} ("${tool.name}"): "args" must be an object`);
    } else {
      for (const [argName, argDef] of Object.entries(tool.args)) {
        if (!argDef || typeof argDef !== 'object') {
          errors.push(`entry ${index} ("${tool.name}"): arg "${argName}" must be an object with "type" and "description"`);
        } else {
          if (!argDef.type || !['string', 'boolean', 'number'].includes(argDef.type)) {
            errors.push(`entry ${index} ("${tool.name}"): arg "${argName}" type must be "string", "boolean", or "number"`);
          }
          if (!argDef.description) {
            errors.push(`entry ${index} ("${tool.name}"): arg "${argName}" needs a "description"`);
          }
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Load and validate a plugin manifest from a project directory. Returns { tools, raw } or null. */
export async function loadPluginManifest(projectPath) {
  const manifestPath = path.join(projectPath, MANIFEST_FILENAME);
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tools)) {
      console.warn(`[pluginTools] ${MANIFEST_FILENAME} exists but has no valid "tools" array`);
      return null;
    }
    const tools = [];
    const errors = [];
    parsed.tools.forEach((entry, i) => {
      const result = validateToolEntry(entry, i);
      if (result.valid) {
        tools.push(entry);
      } else {
        errors.push(...result.errors);
      }
    });
    if (errors.length > 0) {
      console.warn(`[pluginTools] ${manifestPath}: ${errors.join('; ')}`);
    }
    if (tools.length === 0) return null;
    return { tools, raw: parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.warn(`[pluginTools] Failed to load ${MANIFEST_FILENAME}: ${err.message}`);
    return null;
  }
}

/** Build a tool function from a manifest entry. The function interpolates named args into the command string. */
export function createPluginToolFn(entry, root) {
  const { name, command, args: argDefs = {} } = entry;
  return async function pluginTool(callArgs = {}) {
    let resolvedCommand = command;
    // Simple template substitution: {{argName}} or ${argName}
    for (const [key, def] of Object.entries(argDefs)) {
      const value = callArgs[key] !== undefined ? callArgs[key] : def.default;
      if (value === undefined && def.required !== false) {
        return { success: false, error: `"${key}" is required for tool "${name}".` };
      }
      if (value !== undefined) {
        resolvedCommand = resolvedCommand
          .replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), String(value))
          .replace(new RegExp(`\\$\\{${key}\\}`, 'g'), String(value));
      }
    }
    // Import here to avoid circular dependency
    const { exec } = await import('child_process');
    const util = await import('util');
    const execAsync = util.promisify(exec);
    try {
      const { stdout, stderr } = await execAsync(resolvedCommand, { cwd: root, timeout: 30000 });
      return { success: true, data: (stdout + stderr).trim() || '(no output)' };
    } catch (err) {
      return { success: false, error: `Command failed: ${err.message}${err.stdout ? '\n' + err.stdout : ''}${err.stderr ? '\n' + err.stderr : ''}` };
    }
  };
}

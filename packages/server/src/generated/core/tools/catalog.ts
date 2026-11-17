// GENERATED from packages/core/src/tools/catalog.ts. Do not edit.
/**
 * The registry both transports dispatch through (design 3.3). It grows one
 * handler family per slice (10-18); a wire tool not in it still runs through
 * its transport's own `case`.
 */
import { clickTool, findTool } from './interaction.js';
import { createToolRegistry, type ToolRegistry } from './registry.js';

export const TOOL_REGISTRY: ToolRegistry = createToolRegistry([findTool, clickTool]);

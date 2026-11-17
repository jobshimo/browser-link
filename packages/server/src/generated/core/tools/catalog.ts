// GENERATED from packages/core/src/tools/catalog.ts. Do not edit.
/**
 * The registry both transports dispatch through (design 3.3). It grows one
 * handler family per slice (10-18); a wire tool not in it still runs through
 * its transport's own `case`.
 */
import { dragTool } from './drag.js';
import { clickTool, findTool, pressTool, typeTool } from './interaction.js';
import {
  canvasScreenshotTool,
  consoleTool,
  evaluateTool,
  navigateTool,
  networkBodyTool,
  networkTool,
  pingTool,
  screenshotTool,
  snapshotTool,
  stateTool,
} from './page-read.js';
import { createToolRegistry, type ToolRegistry } from './registry.js';
import { waitForTool } from './wait-for.js';

export const TOOL_REGISTRY: ToolRegistry = createToolRegistry([
  findTool,
  clickTool,
  typeTool,
  pressTool,
  waitForTool,
  dragTool,
  pingTool,
  navigateTool,
  snapshotTool,
  stateTool,
  screenshotTool,
  evaluateTool,
  canvasScreenshotTool,
  consoleTool,
  networkTool,
  networkBodyTool,
]);

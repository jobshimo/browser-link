/**
 * The registry both transports dispatch through (design 3.3). It grew one
 * handler family per slice (10-18b); every wire tool a transport runs is in
 * it. Entries are listed in the order of cdp-direct's
 * support table (`cdpToolSupport`); dispatch reads entries by name only.
 */
import { dialogRespondTool, setPermissionTool } from './dialog-permission.js';
import { downloadSettleTool, downloadTool } from './download.js';
import { dragTool } from './drag.js';
import { flowCancelTool, flowStatusTool, flowTool } from './flow.js';
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
  pingTool,
  navigateTool,
  snapshotTool,
  findTool,
  stateTool,
  screenshotTool,
  clickTool,
  typeTool,
  pressTool,
  evaluateTool,
  waitForTool,
  flowTool,
  flowStatusTool,
  flowCancelTool,
  dragTool,
  consoleTool,
  networkTool,
  networkBodyTool,
  canvasScreenshotTool,
  dialogRespondTool,
  setPermissionTool,
  downloadTool,
  downloadSettleTool,
]);

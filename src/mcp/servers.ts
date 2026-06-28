import * as path from 'path';
import * as dotenv from 'dotenv';
import { McpServerConfig } from './client';

dotenv.config();

/**
 * configuration for every MCP server amber connects to.
 * adding a new tool to amber = adding an entry here.
 */
export const SERVER_CONFIGS: McpServerConfig[] = [
  {
    id: 'github',
    command: path.resolve(process.cwd(), 'bin/github-mcp-server'),
    args: ['stdio'],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '',
      // limit to a sane subset — full server exposes 100+ tools
      GITHUB_TOOLSETS: 'repos,issues,pull_requests',
    },
  },
];
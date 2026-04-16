#!/usr/bin/env node

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';

interface McpConfig {
  mcpServers: {
    unguibus: {
      transport: 'sse';
      url: string;
      headers: {
        'X-Unguibus-User': string;
        'X-Unguibus-Group': string;
      };
    };
  };
}

const CONFIG_FILE = resolve(process.cwd(), '.mcp.json');
const DEFAULT_URL = 'http://127.0.0.1:47667/sse';

function createConfig(user: string, group: string, url: string = DEFAULT_URL): McpConfig {
  return {
    mcpServers: {
      unguibus: {
        transport: 'sse',
        url,
        headers: {
          'X-Unguibus-User': user,
          'X-Unguibus-Group': group,
        },
      },
    },
  };
}

function init(user: string, group: string, url?: string): void {
  if (!user || !group) {
    console.error('Error: --user and --group are required');
    process.exit(1);
  }

  if (existsSync(CONFIG_FILE)) {
    console.error(`Error: ${CONFIG_FILE} already exists`);
    process.exit(1);
  }

  const config = createConfig(user, group, url);
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`✓ Created ${CONFIG_FILE}`);
  console.log(`  User: ${user}, Group: ${group}`);
}

function remove(): void {
  if (!existsSync(CONFIG_FILE)) {
    console.error(`Error: ${CONFIG_FILE} not found`);
    process.exit(1);
  }

  unlinkSync(CONFIG_FILE);
  console.log(`✓ Removed ${CONFIG_FILE}`);
}

function parseArgs(args: string[]): { command: string; user?: string; group?: string; url?: string } {
  const command = args[2];
  const result: { command: string; user?: string; group?: string; url?: string } = { command };

  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--user' && args[i + 1]) {
      result.user = args[++i];
    } else if (args[i] === '--group' && args[i + 1]) {
      result.group = args[++i];
    } else if (args[i] === '--url' && args[i + 1]) {
      result.url = args[++i];
    }
  }

  return result;
}

const args = parseArgs(process.argv);

if (!args.command) {
  console.error('Usage: unguibus <init|remove> [options]');
  console.error('');
  console.error('Commands:');
  console.error('  init     Create .mcp.json in current directory');
  console.error('  remove   Delete .mcp.json from current directory');
  console.error('');
  console.error('Options (for init):');
  console.error('  --user <name>     Username (required)');
  console.error('  --group <name>    Group name (required)');
  console.error('  --url <url>       Server URL (default: http://127.0.0.1:47667/sse)');
  process.exit(1);
}

if (args.command === 'init') {
  init(args.user || '', args.group || '', args.url);
} else if (args.command === 'remove') {
  remove();
} else {
  console.error(`Error: unknown command '${args.command}'`);
  process.exit(1);
}

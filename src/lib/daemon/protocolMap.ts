import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BUILTIN_COMMANDS, parseProtocolMap, type CommandDefinition } from '../protocol/commands';

export function protocolMapPath(): string {
  return process.env.OPENPULSE_PROTOCOL_MAP ?? path.join(process.cwd(), 'data', 'protocol-map.json');
}

/**
 * Built-in commands plus the optional user protocol map (data/protocol-map.json),
 * where commands discovered from your own captures can be added without code
 * changes, e.g. {"commands": [{"name": "haptic", "opcode": "0x13", "args": "01"}]}.
 */
export function loadCommandCatalogue(file = protocolMapPath()): { commands: CommandDefinition[]; error: string | null } {
  const builtins = Object.values(BUILTIN_COMMANDS);
  if (!existsSync(file)) return { commands: builtins, error: null };
  try {
    return { commands: [...builtins, ...parseProtocolMap(JSON.parse(readFileSync(file, 'utf8')))], error: null };
  } catch (error) {
    return { commands: builtins, error: `Ignoring ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

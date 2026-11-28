import { execFileSync } from 'node:child_process';

/**
 * Runs kubectl against one kind cluster's context (`kind-atlas-a`) and returns what it prints.
 * Its output is returned, never logged, so a command that reads a token does not print it.
 */
export function kubectl(context: string, ...args: string[]): string {
  return execFileSync('kubectl', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Applies one object, written as a plain object in the journey, through kubectl's standard input. */
export function applyObject(context: string, object: object): string {
  return execFileSync('kubectl', ['--context', context, 'apply', '-f', '-'], { encoding: 'utf8', input: JSON.stringify(object), stdio: ['pipe', 'pipe', 'pipe'] });
}

/** A short-lived token for a ServiceAccount, as a person would paste it into Apply. It is never printed. */
export function createToken(context: string, namespace: string, account: string): string {
  return kubectl(context, '--namespace', namespace, 'create', 'token', account, '--duration', '15m').trim();
}

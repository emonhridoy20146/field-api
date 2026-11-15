import type { Config } from '../config/index.js';
import type { Logger } from '../logger/index.js';
import type { Clock } from '../time/index.js';
import type { EventBus } from '../events/bus.js';
import type { AuthUser } from '../security/types.js';
import type { ModuleManifest } from '../module/types.js';

/**
 * Ports are implemented by core-flagged modules and registered in their manifest `init`.
 * Core depends only on these interfaces, never on module code (boundary rule 2).
 */
export interface Ports {
  /** Loads the current user for a verified access token; null if inactive/missing. */
  loadAuthUser?: (userId: string, sessionId: string) => Promise<AuthUser | null>;
  permissions?: (user: AuthUser) => Promise<Set<string>>;
  flagEnabled?: (key: string, user: AuthUser | null) => Promise<boolean>;
  minAppVersion?: () => Promise<string>;
}

export interface AppContext {
  config: Config;
  clock: Clock;
  logger: Logger;
  bus: EventBus;
  ports: Ports;
  manifests: ModuleManifest[];
}

let current: AppContext | null = null;

export function setContext(ctx: AppContext): void {
  current = ctx;
}

export function ctx(): AppContext {
  if (!current) throw new Error('AppContext not initialised');
  return current;
}

export const now = (): Date => ctx().clock.now();

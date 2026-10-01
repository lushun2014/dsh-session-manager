/**
 * Config resolution for dsh-session-manager: fold defaults, validate pairing,
 * and normalize the local index path.
 * @module dsh-session-manager/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Config } from './index.js'

/** The validated immutable deployment policy. */
export interface ResolvedConfig {
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly indexPath: string
  readonly sessionRoot: string
  readonly projCacheRoot: string
  readonly officialFtsPath: string | undefined
  readonly titleMaxOutputTokens: number
  readonly summaryMaxOutputTokens: number
  readonly timeoutMs: number
  readonly maxInputBytes: number
  readonly maxResults: number
}

const DEFAULT_TITLE_MAX_OUTPUT_TOKENS = 64
const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 1024
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_INPUT_BYTES = 32_768
const DEFAULT_MAX_RESULTS = 20

function defaultIndexPath(): string {
  return join(homedir(), '.dsh-session-manager', 'index.sqlite')
}

/**
 * Default harness home: the `DSH_HOME` env var, or `~/.dsh` when unset.
 * The profile launchers write their session stores under
 * `<dshHome>/sessions` (JSONL persistence root) and `<dshHome>/storages`
 * (durable caches, incl. the session-projection cache).
 */
function dshHome(): string {
  const explicit = process.env['DSH_HOME']?.trim()
  return explicit !== undefined && explicit.length > 0 ? explicit : join(homedir(), '.dsh')
}

function defaultSessionRoot(): string {
  return join(dshHome(), 'sessions')
}

function defaultProjCacheRoot(): string {
  return join(dshHome(), 'storages')
}

function positiveInt(name: string, value: number, fallback: number): number {
  if (!Number.isSafeInteger(value) || value < 1) return fallback
  return value
}

/**
 * Validate and detach the plugin configuration.
 * @param config - the untrusted plugin config from the Loader.
 * @returns the resolved policy.
 * @throws when `provider`/`model` are supplied without a pair.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const hasProvider = config.provider !== undefined && config.provider.trim().length > 0
  const hasModel = config.model !== undefined && config.model.trim().length > 0
  if (hasProvider !== hasModel) {
    throw new Error('dsh-session-manager: provider and model must be supplied together (or both omitted)')
  }
  const provider = hasProvider ? config.provider!.trim() : undefined
  const model = hasModel ? config.model!.trim() : undefined
  const indexPath = config.indexPath?.trim()
  const sessionRoot = config.sessionRoot?.trim()
  const projCacheRoot = config.projCacheRoot?.trim()
  const officialFtsPath = config.officialFtsPath?.trim()
  return {
    provider,
    model,
    indexPath: indexPath !== undefined && indexPath.length > 0 ? indexPath : defaultIndexPath(),
    // Both deletion-target roots default to the harness home layout
    // (<dshHome>/sessions, <dshHome>/storages) so `session_delete` is a full
    // no-trace delete out of the box; an explicit empty string opts out.
    sessionRoot: sessionRoot !== undefined && sessionRoot.length > 0 ? sessionRoot : defaultSessionRoot(),
    projCacheRoot: projCacheRoot !== undefined && projCacheRoot.length > 0 ? projCacheRoot : defaultProjCacheRoot(),
    officialFtsPath: officialFtsPath !== undefined && officialFtsPath.length > 0 ? officialFtsPath : undefined,
    titleMaxOutputTokens: positiveInt('titleMaxOutputTokens', config.titleMaxOutputTokens ?? DEFAULT_TITLE_MAX_OUTPUT_TOKENS, DEFAULT_TITLE_MAX_OUTPUT_TOKENS),
    summaryMaxOutputTokens: positiveInt('summaryMaxOutputTokens', config.summaryMaxOutputTokens ?? DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS, DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS),
    timeoutMs: positiveInt('timeoutMs', config.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxInputBytes: positiveInt('maxInputBytes', config.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES, DEFAULT_MAX_INPUT_BYTES),
    maxResults: positiveInt('maxResults', config.maxResults ?? DEFAULT_MAX_RESULTS, DEFAULT_MAX_RESULTS),
  }
}

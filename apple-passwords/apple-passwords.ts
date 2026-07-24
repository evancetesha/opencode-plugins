import { execFileSync } from "child_process"
import { homedir } from "os"
import type { Plugin } from "@opencode-ai/plugin"

/**
 * Apple Passwords (macOS Keychain) plugin for OpenCode.
 *
 * Reads a secure note from a macOS keychain and injects its KEY=VALUE pairs
 * as shell environment variables.
 *
 * Secrets are loaded on demand: run the `/load-env` command in a session to
 * read the keychain and make the values available to that session's shell
 * commands. Nothing is loaded automatically at startup.
 *
 * The command takes an optional argument selecting the keychain:
 *   /load-env            - default keychain (OPENCODE_KEYCHAIN or built-in default)
 *   /load-env work       - ~/Library/Keychains/work.keychain-db
 *   /load-env ~/path.db  - an explicit keychain path
 *
 * Configuration (env vars):
 *   OPENCODE_KEYCHAIN         - Path to keychain (default: ~/Library/Keychains/opencode.keychain-db)
 *   OPENCODE_KEYCHAIN_SERVICE - Service name (default: opencode)
 *   OPENCODE_KEYCHAIN_ACCOUNT - Account name (default: opencode)
 *
 * Setup:
 *   security create-keychain -P "$OPENCODE_KEYCHAIN"
 *   security set-keychain-settings -t 300 -lu "$OPENCODE_KEYCHAIN"
 *
 * Store secrets:
 *   security add-generic-password -s opencode -a opencode -D "secure note" -T "" \
 *     -w "KEY1=value1
 *   KEY2=value2" "$OPENCODE_KEYCHAIN"
 *
 * Update secrets (delete + re-add):
 *   security delete-generic-password -s opencode -a opencode -D "secure note" \
 *     "$OPENCODE_KEYCHAIN"
 *   # then re-add with updated content
 */

const SERVICE = "apple-passwords"
const COMMAND = "load-env"
const KEYCHAIN_DIR = `${homedir()}/Library/Keychains`
const KEYCHAIN_SUFFIX = ".keychain-db"
const PROFILE_NAME = /^[A-Za-z0-9._-]+$/
const DEFAULT_KEYCHAIN = `${KEYCHAIN_DIR}/opencode${KEYCHAIN_SUFFIX}`
const DEFAULT_ITEM_SERVICE = "opencode"
const DEFAULT_ITEM_ACCOUNT = "opencode"
const ITEM_KIND = "secure note"
const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const DENYLIST = new Set([
  "PATH", "SHELL", "IFS", "HOME", "USER", "LOGNAME", "PWD", "OLDPWD",
  "CDPATH", "ENV", "BASH_ENV", "PROMPT_COMMAND", "ZDOTDIR", "FPATH",
  "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP",
  "RUBYLIB", "RUBYOPT", "PERL5LIB", "PERL5OPT", "PERLLIB",
  "GIT_SSH", "GIT_SSH_COMMAND",
])
const DENY_PREFIXES = ["LD_", "DYLD_", "BASH_FUNC_", "GIT_CONFIG_"]

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve a `/load-env` argument to a keychain path.
 *   ""            -> the default keychain (OPENCODE_KEYCHAIN or built-in default)
 *   "work"        -> ~/Library/Keychains/work.keychain-db  (profile name)
 *   "./x" | "~/x" -> treated as an explicit path (leading ~ expanded)
 * Returns null for names that are neither a path nor a safe profile name.
 */
function resolveKeychain(arg: string, fallback: string): string | null {
  const value = arg.trim()
  if (!value) return fallback

  if (value.includes("/")) {
    return value.startsWith("~/") ? `${homedir()}${value.slice(1)}` : value
  }

  if (!PROFILE_NAME.test(value)) return null

  const base = value.endsWith(KEYCHAIN_SUFFIX)
    ? value.slice(0, -KEYCHAIN_SUFFIX.length)
    : value
  return `${KEYCHAIN_DIR}/${base}${KEYCHAIN_SUFFIX}`
}

function isAllowedName(name: string): boolean {
  if (!VALID_ENV_NAME.test(name)) return false
  if (DENYLIST.has(name)) return false
  if (DENY_PREFIXES.some((p) => name.startsWith(p))) return false
  return true
}

/**
 * Parse .env-style content into key-value pairs.
 * Supports: KEY=VALUE, blank lines, # comments, quoted values.
 */
function parseEnv(raw: string): { env: Record<string, string>; skipped: string[] } {
  const env: Record<string, string> = {}
  const skipped: string[] = []

  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const eqIdx = trimmed.indexOf("=")
    if (eqIdx === -1) {
      skipped.push(trimmed)
      continue
    }

    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1)

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (!isAllowedName(key)) {
      skipped.push(key)
      continue
    }

    env[key] = value
  }

  return { env, skipped }
}

/**
 * Decode hex-encoded output from `security -w`.
 * When the stored password contains non-ASCII or newlines, `security -w`
 * returns the value as a hex string (each byte as two hex chars).
 */
function decodeHex(hex: string): string {
  const bytes = Buffer.from(hex, "hex")
  return bytes.toString("utf-8")
}

/**
 * Detect if a string is hex-encoded output from `security -w`.
 * Hex output contains only [0-9a-f] and no whitespace/newlines.
 */
function isHexEncoded(value: string): boolean {
  return /^[0-9a-f]+$/.test(value) && value.length % 2 === 0
}

/**
 * Fetch the single secure note from the dedicated keychain and parse it.
 */
function fetchNote(keychain: string, service: string, account: string): { ok: true; raw: string } | { ok: false; error: string } {
  try {
    let raw = execFileSync(
      "security",
      [
        "find-generic-password",
        "-s", service,
        "-a", account,
        "-D", ITEM_KIND,
        "-w",
        keychain,
      ],
      { encoding: "utf-8" },
    )
    // security -w appends a trailing newline
    raw = raw.endsWith("\n") ? raw.slice(0, -1) : raw
    // Multi-line passwords are hex-encoded by security -w
    if (isHexEncoded(raw)) {
      raw = decodeHex(raw)
    }
    return { ok: true, raw }
  } catch (error) {
    return { ok: false, error: formatError(error) }
  }
}

async function loadSecrets(client: Parameters<Plugin>[0]["client"], keychain: string, service: string, account: string): Promise<Record<string, string>> {
  const result = fetchNote(keychain, service, account)
  if (!result.ok) {
    await client.app.log({
      body: {
        service: SERVICE,
        level: "warn",
        message: `Failed to read secure note (service=${service}) from ${keychain}`,
        extra: { error: result.error },
      },
    })
    return {}
  }

  const { env, skipped } = parseEnv(result.raw)

  if (skipped.length > 0) {
    await client.app.log({
      body: {
        service: SERVICE,
        level: "warn",
        message: `Skipped ${skipped.length} invalid entry(s): ${skipped.join(", ")}`,
      },
    })
  }

  await client.app.log({
    body: {
      service: SERVICE,
      level: "info",
      message: `Loaded ${Object.keys(env).length} secret(s) from ${keychain}`,
    },
  })

  return env
}

export const ApplePasswordsPlugin: Plugin = async ({ client }) => {
  if (process.platform !== "darwin") return {}

  const keychain = process.env.OPENCODE_KEYCHAIN || DEFAULT_KEYCHAIN
  const service = process.env.OPENCODE_KEYCHAIN_SERVICE || DEFAULT_ITEM_SERVICE
  const account = process.env.OPENCODE_KEYCHAIN_ACCOUNT || DEFAULT_ITEM_ACCOUNT

  // Secrets are loaded on demand via the `/load-env` command, never at startup.
  let env: Record<string, string> = {}

  return {
    config: async (config) => {
      if (!config.command) config.command = {}
      if (!config.command[COMMAND]) {
        config.command[COMMAND] = {
          description:
            "Load secrets from a macOS keychain into the shell environment. Optional arg selects the keychain: /load-env <name|path>",
          template:
            "Keychain secrets have been loaded into this session's shell environment. Briefly confirm they are available.",
        }
      }
    },
    "command.execute.before": async (input) => {
      if (input.command !== COMMAND) return
      const target = resolveKeychain(input.arguments ?? "", keychain)
      if (target === null) {
        await client.app.log({
          body: {
            service: SERVICE,
            level: "warn",
            message: `Ignoring /load-env: invalid keychain argument "${input.arguments}"`,
          },
        })
        return
      }
      env = await loadSecrets(client, target, service, account)
    },
    "shell.env": async (_input, output) => {
      Object.assign(output.env, env)
    },
  }
}

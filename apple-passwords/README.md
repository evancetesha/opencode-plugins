# apple-passwords

An OpenCode plugin that reads a secure note from a dedicated macOS Keychain and
injects its `KEY=VALUE` pairs as shell environment variables — on demand, when
you run the `/load-env` command in a session.

- **On demand** — nothing is read at startup; run `/load-env` to load secrets
  into the current session's shell environment.
- **Per session** — loaded values are scoped to the session that ran `/load-env`
  and are evicted when that session is deleted; other sessions are unaffected.
- **Local only** — no network calls, no config files, no master-password env var.
- **macOS only** — the plugin is a no-op on other platforms.
- **Cached** — once loaded, values are held in-memory for the session; run
  `/load-env` again to refresh after changing the keychain.

## Install

Copy the plugin into your OpenCode plugins directory:

```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/evancetesha/opencode-plugins/main/apple-passwords/apple-passwords.ts \
  -o ~/.config/opencode/plugins/apple-passwords.ts
```

## Usage

The plugin registers a `/load-env` command. In an OpenCode session, run:

```
/load-env
```

This reads the keychain and injects the values into the environment used by
subsequent shell commands in that session. Run it again at any time to refresh
after updating the keychain. Nothing is loaded automatically at startup.

### Selecting a keychain

`/load-env` takes an optional argument to choose which keychain to read, so you
can switch between keychains within a session:

| Command | Keychain read |
| --- | --- |
| `/load-env` | The default (`OPENCODE_KEYCHAIN`, or `~/Library/Keychains/opencode.keychain-db`) |
| `/load-env work` | `~/Library/Keychains/work.keychain-db` (bare name → profile) |
| `/load-env ~/secrets/ci.keychain-db` | An explicit path (leading `~` expanded) |

A bare name must match `[A-Za-z0-9._-]+`; a trailing `.keychain-db` is optional
and added automatically. Anything containing a `/` is treated as a path.
Loading replaces the previously loaded values for the session.

The item's service/account within the selected keychain still come from
`OPENCODE_KEYCHAIN_SERVICE` / `OPENCODE_KEYCHAIN_ACCOUNT` (defaults `opencode`).

## Configuration

Configured via environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_KEYCHAIN` | `~/Library/Keychains/opencode.keychain-db` | Path to the keychain to read from. |
| `OPENCODE_KEYCHAIN_SERVICE` | `opencode` | Keychain item service name. |
| `OPENCODE_KEYCHAIN_ACCOUNT` | `opencode` | Keychain item account name. |

## Setup

Create a dedicated keychain (keeps these secrets isolated from your login keychain):

```sh
security create-keychain -P "$HOME/Library/Keychains/opencode.keychain-db"
security set-keychain-settings -t 300 -lu "$HOME/Library/Keychains/opencode.keychain-db"
```

Store your secrets as a single secure note whose body is `.env`-style content:

```sh
security add-generic-password -s opencode -a opencode -D "secure note" -T "" \
  -w 'API_KEY="sk-123"
DATABASE_URL="postgres://user:pass@host/db"' \
  "$HOME/Library/Keychains/opencode.keychain-db"
```

Update secrets (delete + re-add):

```sh
security delete-generic-password -s opencode -a opencode -D "secure note" \
  "$HOME/Library/Keychains/opencode.keychain-db"
# then re-add with the updated content
```

## Secret format

The secure note body is parsed as `.env`-style content:

- `KEY=VALUE` per line. Whitespace around the key and value is trimmed, so
  `KEY = "value"` also works.
- Blank lines and whole-line `#` comments are ignored. `#` is **not** treated as
  an inline comment, so unquoted values may contain it.
- Values may be double-quoted (`KEY="value"`), single-quoted (`KEY='value'`), or
  unquoted. In double quotes the escapes `\n \r \t \f \b \" \\` are expanded; in
  single quotes the value is taken literally.
- Multi-line values are hex-decoded automatically (macOS `security -w` behavior).

## Safety

Environment variable names are part of the security boundary because the
`shell.env` hook injects them into every shell execution. The plugin therefore
skips any name that:

- is not a valid shell identifier (`^[A-Za-z_][A-Za-z0-9_]*$`),
- is on the denylist (`PATH`, `SHELL`, `HOME`, `NODE_OPTIONS`, `PYTHONPATH`, …), or
- starts with a dangerous prefix (`LD_`, `DYLD_`, `BASH_FUNC_`, `GIT_CONFIG_`).

Skipped entries and load counts are logged via the OpenCode client logger.

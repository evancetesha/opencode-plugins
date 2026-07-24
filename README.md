# opencode-plugins

A collection of [OpenCode](https://opencode.ai) plugins.

## Plugins

| Plugin | Description |
| --- | --- |
| [apple-passwords](./apple-passwords) | Inject secrets from a macOS Keychain as shell environment variables. |

## Installing a plugin

OpenCode loads plugins from `.opencode/plugins/` (project-level) or
`~/.config/opencode/plugins/` (global). Copy the plugin's `.ts` file into one of
those directories:

```sh
# Global install (example: apple-passwords)
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/evancetesha/opencode-plugins/main/apple-passwords/apple-passwords.ts \
  -o ~/.config/opencode/plugins/apple-passwords.ts
```

See each plugin's own README for setup and configuration.

## License

MIT

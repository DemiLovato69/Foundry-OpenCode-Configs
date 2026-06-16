# OpenCode Config

Personal OpenCode configuration for routing OpenAI, Anthropic, Google, and xAI models through the same proxy endpoint. Ponytail is installed by default through the `plugin` array in `opencode.jsonc`; remove `./plugins/ponytail.mjs` from that array if you do not want Ponytail enabled.

## Install OpenCode

Install OpenCode with the official install script:

```sh
curl -fsSL https://opencode.ai/install | bash
```

Alternative installs:

```sh
npm install -g opencode-ai
brew install anomalyco/tap/opencode
```

After installing, confirm the binary is available:

```sh
opencode --version
```

## Install This Config

Clone or copy this repository into OpenCode's global config directory:

```sh
mkdir -p ~/.config
git clone <repo-url> ~/.config/opencode
```

If `~/.config/opencode` already exists, back it up first or copy only the files you want:

```sh
mkdir -p ~/.config/opencode
cp opencode.jsonc ~/.config/opencode/opencode.jsonc
cp -R command ~/.config/opencode/command
cp -R plugins ~/.config/opencode/plugins
cp package.json ~/.config/opencode/package.json
```

Install the provider and plugin dependencies from the config directory:

```sh
cd ~/.config/opencode
npm install
```

This config loads:

- `./plugins/ponytail.mjs`
- `./plugins/lms-responses-compat.js`
- commands from `./command/*.md`
- provider packages from `package.json`

Ponytail is enabled by the `./plugins/ponytail.mjs` entry in `opencode.jsonc`. To disable Ponytail, remove that one entry from the `plugin` array and restart OpenCode.

Restart OpenCode after changing `opencode.jsonc`, plugins, commands, or environment variables. OpenCode reads config at startup.

## Environment Variables

This config expects a proxy base URL and a bearer token.

Required:

```sh
export OPENCODE_BASE_URL="https://your-foundry-stack.palantir.com"
export OPENCODE_API_KEY="your-foundry-token"
```

`OPENCODE_BASE_URL` is used to build provider URLs like:

```text
${OPENCODE_BASE_URL}/api/v2/llm/proxy/openai/v1
${OPENCODE_BASE_URL}/api/v2/llm/proxy/anthropic/v1
${OPENCODE_BASE_URL}/api/v2/llm/proxy/google/v1
${OPENCODE_BASE_URL}/api/v2/llm/proxy/xai/v1
```

`OPENCODE_API_KEY` is sent as:

```text
Authorization: Bearer ${OPENCODE_API_KEY}
```

### Foundry Token

If you already have a Foundry token in `FOUNDRY_TOKEN`, it is enough to set the OpenCode token from it:

```sh
export OPENCODE_API_KEY=$(echo $FOUNDRY_TOKEN)
```

## Add Variables To zshrc

Add the exports to `~/.zshrc` so new terminal sessions have them automatically.

For a direct OpenCode token:

```sh
cat >> ~/.zshrc <<'EOF'

# OpenCode proxy configuration
export OPENCODE_BASE_URL="https://your-foundry-stack.palantir.com"
export OPENCODE_API_KEY="your-foundry-token"
EOF
```

For a Foundry token:

```sh
cat >> ~/.zshrc <<'EOF'

# OpenCode proxy configuration
export OPENCODE_BASE_URL="https://your-foundry-stack.palantir.com"
export OPENCODE_API_KEY=$(echo $FOUNDRY_TOKEN)
EOF
```

Reload your shell config:

```sh
source ~/.zshrc
```

Verify the variables are present without printing the secret value:

```sh
test -n "$OPENCODE_BASE_URL" && echo "OPENCODE_BASE_URL is set"
test -n "$OPENCODE_API_KEY" && echo "OPENCODE_API_KEY is set"
```

## Start OpenCode

From any project directory:

```sh
opencode
```

The default model is `openai/gpt-5.5`, and the small model is `anthropic/claude-haiku-4-5`.

## Install Palantir MCP

Palantir MCP lets OpenCode use Foundry tools through the Model Context Protocol. The Palantir wrapper package is `palantir-mcp` and runs through `npx`.

Requirements:

- Node.js 18 or newer
- access to a Foundry enrollment
- `OPENCODE_BASE_URL` set to the Foundry URL
- `OPENCODE_API_KEY` set to the Foundry token

Verify the OpenCode variables are present without printing the token:

```sh
test -n "$OPENCODE_BASE_URL" && echo "OPENCODE_BASE_URL is set"
test -n "$OPENCODE_API_KEY" && echo "OPENCODE_API_KEY is set"
```

Add the Palantir MCP server to the top level of `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "palantir": {
      "type": "local",
      "command": [
        "sh",
        "-c",
        "FOUNDRY_TOKEN=\"$OPENCODE_API_KEY\" exec npx -y palantir-mcp --foundry-api-url \"$OPENCODE_BASE_URL\""
      ],
      "enabled": true
    }
  }
}
```

Keep the actual token out of `opencode.jsonc`; the MCP command reads it from `OPENCODE_API_KEY`. Palantir MCP expects the token in an environment variable named `FOUNDRY_TOKEN`, so the command maps `OPENCODE_API_KEY` to `FOUNDRY_TOKEN` only for the MCP process.

If you want to test Palantir MCP before using it in OpenCode, run:

```sh
npx @modelcontextprotocol/inspector \
  npx -y palantir-mcp \
  --foundry-api-url \
  "$OPENCODE_BASE_URL"
```

Restart OpenCode after adding or changing MCP config. Once it starts, you can ask OpenCode to use the `palantir` MCP tools in your prompt.

# pi-provider-litellm

> [!NOTE]
> This extension requires [pi](https://github.com/earendil-works/pi) and a running [LiteLLM](https://github.com/BerriAI/litellm) proxy.

Pi agent extension that auto-discovers and registers models, MCP tools, and skills from a LiteLLM proxy.

## Features

- **Model discovery** — queries `/health` and `/model/info` endpoints to discover available models, registers them under the `litellm` provider with cost, context window, and capability metadata
- **MCP tools** — discovers tools from LiteLLM's MCP REST gateway (`/mcp-rest/tools/list`) and registers them as pi tools with JSON schema to TypeBox mapping
- **Skills management** — `skill_list`, `skill_use`, `skill_register`, `skill_enable`, and `skill_disable` tools for managing LiteLLM skills
- **Skills injection** — injects enabled skills as structured context into the agent's system prompt on session start, with 60-second caching

All discovery runs in parallel with a 30s timeout. Each step fails gracefully — a failed model discovery won't block MCP tools or skills.

## Installation

```bash
# From npm (once published)
pi install npm:@danmademe/pi-provider-litellm

# From local path
pi install npm:@danmademe/pi-provider-litellm
```

## Configuration

Provide your LiteLLM proxy URL and API key via environment variables or settings.

### Environment variables (recommended)

```bash
export LITELLM_URL="https://your-litellm-proxy.example.com"
export LITELLM_KEY="sk-your-api-key"
```

Optional: override the provider name (defaults to `litellm`):

```bash
export LITELLM_PROVIDER_ID="my-proxy"
```

### Settings file

Add to `~/.pi/agent/settings.json`:

```json
{
  "pi-provider-litellm": {
    "url": "https://your-litellm-proxy.example.com",
    "token": "sk-your-api-key"
  }
}
```

Optional: override the provider name:

```json
{
  "pi-provider-litellm": {
    "url": "https://your-litellm-proxy.example.com",
    "token": "sk-your-api-key",
    "providerId": "my-proxy"
  }
}
```

Environment variables take precedence over the settings file.

### Enabling models

Models registered by this extension use the configured provider ID (default: `litellm`). To include them in your model cycling, add them to `enabledModels` in `settings.json`:

```json
{
  "enabledModels": [
    "litellm/qwen/qwen3.6-27b",
    "litellm/anthropic/claude-sonnet"
  ]
}
```

> [!TIP]
> The model ID in pi is `<providerId>/<model_name>`, where `<providerId>` defaults to `litellm` and `<model_name>` is the ID as reported by your LiteLLM proxy (e.g., `qwen/qwen3.6-27b`, `anthropic/claude-sonnet`).

## Tools

Once loaded, the extension registers the following tools:

| Tool | Description |
|------|-------------|
| `skill_list` | List all available skills on the proxy |
| `skill_use` | Fetch full content of a skill by name |
| `skill_register` | Register a new skill from a git repository |
| `skill_enable` | Enable a skill by name |
| `skill_disable` | Disable a skill by name |
| `mcp_<server>_<tool>` | Auto-discovered MCP tools from the proxy |

## Development

```bash
npm install
npm run typecheck
npm run test:run
```

## License

MIT

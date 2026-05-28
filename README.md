# pi-provider-litellm

Pi agent extension that auto-discovers and registers models, MCP tools, and skills from a [LiteLLM](https://github.com/BerriAI/litellm) proxy.

## What it does

- **Model discovery** — queries the LiteLLM `/health` and `/model/info` endpoints to discover available models and registers them with pi under the `litellm` provider
- **MCP tools** — discovers tools from LiteLLM's MCP REST gateway (`/mcp-rest/tools/list`) and registers them as pi tools with proper schema mapping
- **Skills CRUD** — provides `skill_list`, `skill_use`, `skill_register`, `skill_enable`, and `skill_disable` tools for managing LiteLLM skills
- **Skills system prompt injection** — injects enabled skills as XML-structured context into the agent's system prompt on each session start, with 60-second caching

## Installation

Install via pi's extension mechanism:

```bash
pi extension install pi-provider-litellm
```

Or install from a local path / git URL:

```bash
pi extension install ./path/to/pi-provider-litellm
pi extension install https://github.com/user/pi-provider-litellm
```

## Configuration

Provide your LiteLLM proxy URL and API key via one of these methods:

### Environment variables

```bash
export LITELLM_URL="http://localhost:4000"
export LITELLM_KEY="sk-your-api-key"
```

### Settings file

Add configuration to `~/.pi/agent/settings.json` under the `pi-provider-litellm` key:

```json
{
  "pi-provider-litellm": {
    "url": "http://localhost:4000",
    "token": "sk-your-api-key"
  }
}
```

Environment variables take precedence over the settings file.

## Features

- **Parallel discovery** — models, MCP tools, and skills are discovered concurrently on startup and session start
- **Graceful degradation** — if model discovery fails, MCP tools and skill tools still register (and vice versa)
- **Schema mapping** — MCP tool JSON schemas are mapped to TypeBox schemas with support for strings, numbers, booleans, arrays, enums, and required fields
- **Cost conversion** — LiteLLM per-token costs (per token) are converted to pi's format (per million tokens)
- **Vision & reasoning flags** — models with `supports_vision` get image input capability; `supports_reasoning` is mapped to the reasoning flag
- **No runtime dependencies** — only peer dependencies on `@earendil-works/pi-coding-agent` and `typebox`

## Development

```bash
npm install
npm run typecheck
npm run test:run
```

## License

MIT

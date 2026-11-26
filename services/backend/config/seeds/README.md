# Seed files

## `models.seed.json`: the models configuration file

The agent uses ONE model, which you connect in **Settings → Model**: Sign in with ChatGPT, or an
API key for Anthropic (Claude), OpenAI, DeepSeek, Qwen or Moonshot. Anything else, such as a model
on Ollama, vLLM, LM Studio or a router, is added here. `npm run db:seed` (and every
`docker compose up`) reads this file.

Each entry is one model row:

| Field | Meaning |
| --- | --- |
| `name`, `modelName`, `description` | Shown name, the model id the server expects, a note. |
| `provider` | `OPENAI` for any OpenAI-compatible server; or `ANTHROPIC`, `DEEPSEEK`, `QWEN`, `MOONSHOT`. |
| `apiBaseUrl` | The server, such as `http://127.0.0.1:11434/v1` for Ollama (`http://host.docker.internal:11434/v1` from Docker). |
| `apiKeyEnv` / `apiKey` | Where its key comes from. A server of its own never gets the provider's `*_API_KEY`; leave both out when it takes no key. |
| `isDefault` | `true` connects this entry when nothing is connected yet. At most one entry. |
| `contextWindow`, `maxOutputTokens`, `requestProfile`, `selectionCategory` | Optional limits and provider settings. |
| `rateCards` | Optional prices, so usage shows a cost; without them a call is recorded at zero. |

Example, Ollama on this computer:

```json
{
  "name": "Llama 3.1 on Ollama",
  "provider": "OPENAI",
  "modelName": "llama3.1",
  "apiBaseUrl": "http://127.0.0.1:11434/v1",
  "isDefault": true,
  "contextWindow": 128000
}
```

The model must accept OpenAI chat completions with streaming and tool calls; the agent needs both.

What the seed does with the connection:

- It never changes a connection you made. With none yet, it connects the `isDefault` entry when it
  has a key or a server of its own; otherwise the first provider key set in `.env`
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `QWEN_API_KEY`, `MOONSHOT_API_KEY`, in
  that order), on that provider's newest chat model.
- Disconnecting in **Settings → Model** and restarting lets that happen again.

The other entries already here are the catalogue of hosted models with their prices.

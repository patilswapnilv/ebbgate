# Why not just LiteLLM fallbacks?

[LiteLLM](https://github.com/BerriAI/litellm) already supports model fallbacks: if `ollama/llama3` fails, try `openai/gpt-4o-mini`. That is the right tool for **per-call** reliability.

Ebbgate answers a different question: **where should this whole agent task run**, given the user’s machine and the task’s sensitivity?

|             | LiteLLM fallbacks                     | Ebbgate                                                     |
| ----------- | ------------------------------------- | ----------------------------------------------------------- |
| Unit        | One LLM HTTP call                     | One Paperclip heartbeat / issue wake                        |
| Trigger     | Provider error / timeout              | Presence: available / busy / offline                        |
| Privacy     | Model A → model B (often still cloud) | Private work can **wait**, never silently leave the machine |
| Local files | No notion of “needs the Mac”          | Label `local-files` → local or defer                        |
| Resume      | Retries the same call                 | Deferred queue + `wakeAgent` when the node returns          |

Use both:

- **LiteLLM** — `private-fast` / `private-smart` stay on Ollama; `internal-smart` may fall through to a cloud model _after_ Ebbgate already chose a local or cloud **runtime**.
- **Ebbgate** — decides the runtime (local shim vs cloud OpenClaw) before the agent process starts spending tokens.

Putting presence and privacy into LiteLLM fallbacks would either leak private prompts to the next model in the chain, or force every call path to know about battery state and launchd. That belongs one layer up.

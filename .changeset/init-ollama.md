---
"ebbgate": minor
---

`ebbgate init` now gets you a working local model. If Ollama isn't reachable it explains why it's needed and offers to install it (`brew install ollama` on macOS, the download link without Homebrew, the official install script on Linux only after an interactive yes), starts it, and offers to pull a small default model (`llama3.2`, or `--model NAME`). The model is recorded under a new optional `local:` section in `ebbgate.yaml` and used for LiteLLM's `private-fast` alias. `--yes` accepts, `--no-ollama` skips, and non-interactive runs skip with a message. `ebbgate doctor` gives the same platform-specific hints and warns when the configured model isn't pulled.

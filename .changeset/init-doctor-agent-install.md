---

## "ebbgate": minor

Zero to running in five minutes: `ebbgate init` now writes a minimal, secure config (no cloud runner unless you give one, unknown agents private) and generates secrets into `.env` with mode 600, never printing them in full; `--force` keeps existing secrets. New `ebbgate doctor` checks Node, config, secrets-file permissions, dispatcher reachability and auth, presence heartbeat, Ollama, cloud runner, SQLite and Paperclip, with a fix per line, `--json`, and a non-zero exit on failure. `ebbgate agent install` infers the node from a one-node config. `cloud.runner` is now optional; without it, rules may not use `cloud`.

---
"ebbgate": minor
---

Add `ebbgate serve`: start the dispatcher in one command from the folder with `ebbgate.yaml` (loads `.env` beside it; `--config` / `--env` for other paths), print its listen and `/run` URLs, and shut down cleanly on SIGINT/SIGTERM. `ebbgate agent install` now defaults the dispatcher URL to `server.publicUrl` from the config, and `ebbgate doctor` / `ebbgate init` point at `ebbgate serve`.

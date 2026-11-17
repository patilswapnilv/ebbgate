# Ebbgate Compose quickstart

Bring up the dispatcher + LiteLLM in Docker, then run the presence agent on your Mac.

## Prerequisites

- Docker Desktop (or Engine + Compose v2)
- Node 22+ / pnpm 10 (for the local agent + runner)
- Optional: [Ollama](https://ollama.com) on the host (`:11434`), Paperclip on the host (`:3100`)

## 1. Configure secrets

```bash
cp examples/compose/.env.example examples/compose/.env
# edit .env — every *TOKEN / *SECRET must be ≥16 characters
```

## 2. Start the stack

From the repo root:

```bash
docker compose -f examples/compose/docker-compose.yml up --build
```

- Dispatcher: http://127.0.0.1:8790/healthz
- LiteLLM: http://127.0.0.1:4000 (this machine only; requests need `Authorization: Bearer $LITELLM_MASTER_KEY`)

Paperclip is not started by default (image/tag still `TODO(verify-paperclip)`). Run your own Paperclip on the host and point agents at `http://127.0.0.1:8790/run`.

## 3. Local node (Mac)

A node needs exactly one secret: its own token. Put it in a node-only env file that only you can read. The agent never needs the dispatcher's Paperclip key or notifier tokens.

```bash
mkdir -p ~/.ebbgate
grep '^EG_NODE_MINI_TOKEN=' examples/compose/.env > ~/.ebbgate/.env
chmod 600 ~/.ebbgate/.env
```

Both the launchd daemon and `ebbgate runner` read this file, so they work from a fresh shell and after a reboot. Values in your shell environment take precedence over it. `agent install` stores only the file's path in the launchd job, never the token, and refuses to install if the token can't be found there.

```bash
# from the repo root
pnpm install && pnpm build
pnpm ebbgate agent install \
  --node mini \
  --dispatcher http://127.0.0.1:8790 \
  --config examples/compose/ebbgate.yaml \
  --env-file ~/.ebbgate/.env \
  --runner-host 0.0.0.0

# stable runner endpoint the dispatcher calls via host.docker.internal:8787
pnpm ebbgate runner
```

Check presence:

```bash
curl -s -H "Authorization: Bearer $EG_PAPERCLIP_SECRET" http://127.0.0.1:8790/status | jq .
```

## 4. Wire Paperclip

For each agent that should go through Ebbgate:

| Field                   | Value                          |
| ----------------------- | ------------------------------ |
| `adapterType`           | `http`                         |
| `url`                   | `http://127.0.0.1:8790/run`    |
| `headers.Authorization` | `Bearer <EG_PAPERCLIP_SECRET>` |

## Fresh machine via init

```bash
# from the repo root, after pnpm install && pnpm build
pnpm ebbgate init
# or non-interactive:
pnpm ebbgate init --yes
```

`pnpm ebbgate` runs the built CLI (`packages/cli/dist/cli.js`) in the directory you call it from, so relative paths such as `--config ./ebbgate.yaml` resolve where you expect. It writes `ebbgate.yaml`, `.env.example` and `litellm.config.yaml` there, and refuses to replace existing files unless you pass `--force`.

`--config` is stored as an absolute path, so the installed agent finds it no matter where launchd starts it. `--runner-host 0.0.0.0` lets the dispatcher container reach the runner; on a shared network, prefer a VPN/Tailscale IP.

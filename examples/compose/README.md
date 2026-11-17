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
- LiteLLM: http://127.0.0.1:4000

Paperclip is not started by default (image/tag still `TODO(verify-paperclip)`). Run your own Paperclip on the host and point agents at `http://127.0.0.1:8790/run`.

## 3. Local node (Mac)

```bash
pnpm install && pnpm build
pnpm --filter @ebbgate/cli exec ebbgate agent install \
  --node mini \
  --dispatcher http://127.0.0.1:8790 \
  --config examples/compose/ebbgate.yaml

# stable runner endpoint the dispatcher calls via host.docker.internal:8787
pnpm --filter @ebbgate/cli exec ebbgate runner
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
pnpm --filter @ebbgate/cli exec ebbgate init
# or non-interactive:
pnpm --filter @ebbgate/cli exec ebbgate init --yes
```

Writes `ebbgate.yaml`, `.env.example`, and `litellm.config.yaml` in the current directory.

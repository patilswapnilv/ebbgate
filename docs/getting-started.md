# Getting started

This is the from-zero path: a machine with none of the stack installed, through to a working Ebbgate setup in front of Paperclip.

**Honest time:** about an hour, not five minutes. Ebbgate itself takes about five minutes once the other tools are in place. The rest is installing Node, downloading an Ollama model, and setting up Paperclip. The times below are rough estimates; nobody has timed a clean-machine run yet.

If you only want to see what Ebbgate does, skip this page and run the demo. It needs no Paperclip, no Ollama, and no API keys:

```bash
# once the package is on npm:
npx ebbgate demo

# until then, from a checkout:
git clone https://github.com/patilswapnilv/ebbgate.git
cd ebbgate && pnpm install && pnpm build && pnpm ebbgate demo
```

## Before you start: install Paperclip

Ebbgate is a presence-aware router for [Paperclip](https://paperclip.ing) agent tasks. It does not replace Paperclip. Install and run Paperclip first, then come back here.

Follow Paperclip's own docs — do not invent commands, and if a step below is marked `TODO(verify-paperclip)`, treat the official page as the source of truth:

- [Installation (local or self-hosted)](https://docs.paperclip.ing/guides/getting-started/installation/)
- [Installing the CLI](https://docs.paperclip.ing/reference/cli/installation/)
- [Create your first company](https://docs.paperclip.ing/guides/getting-started/your-first-company/)
- Repo and alternate install methods: [paperclipai/paperclip](https://github.com/paperclipai/paperclip), including [`doc/INSTALLING.md`](https://github.com/paperclipai/paperclip/blob/HEAD/doc/INSTALLING.md)

### Node.js 24.11 or newer

Paperclip requires **Node.js 24.11.0 or newer**. Ebbgate's own minimum is Node 22, so one 24.11+ install covers both. Check first:

```bash
node --version   # must report v24.11.0 or higher
```

If you don't have that, download the LTS installer from [nodejs.org](https://nodejs.org) and run it, as the [Paperclip installation guide](https://docs.paperclip.ing/guides/getting-started/installation/) describes.

A managed `paperclipai` install refuses to run on an older Node. An `npx` install on Node 22 or 23 may print a warning and continue, but Paperclip's docs are explicit: that is not support — upgrade before you rely on it.

Paperclip's installation guide also has you install [pnpm](https://pnpm.io) (via Corepack). You will want pnpm for Ebbgate too until the package is published to npm, because the checkout build uses it:

```bash
npm install -g corepack
corepack enable
corepack prepare pnpm@latest --activate
```

Those three lines are copied from Paperclip's installation guide.

### Install and start Paperclip

Do **not** run this with `sudo` or from a root/admin shell. The default setup starts embedded PostgreSQL, which refuses to run as an administrative user. Run it as your normal user.

The canonical first command, from the official installation and CLI docs:

```bash
npx paperclipai onboard --yes
```

That downloads Paperclip, writes config under `~/.paperclip/`, initialises an embedded database, and starts the server at [http://localhost:3100](http://localhost:3100). `--yes` accepts the Quickstart defaults; omit it if you want to customise deployment mode, database, or storage.

To start Paperclip again later (for example after a reboot):

```bash
npx paperclipai run
```

If you used `npx` for setup, keep using `npx paperclipai …` for later commands. The bare `paperclipai` binary is on your `PATH` only after a managed or global install.

For a longer-lived install you can update, roll back, and run as a background service, see the [managed install](https://docs.paperclip.ing/reference/cli/installation/) (`npx paperclipai install`, then `paperclipai onboard` and optionally `paperclipai service install`). There is also a checksummed bootstrap script documented in [`doc/INSTALLING.md`](https://github.com/paperclipai/paperclip/blob/HEAD/doc/INSTALLING.md).

### Create a company

Open [http://localhost:3100](http://localhost:3100) (Paperclip often opens it for you). You land in the setup wizard: name an organization, hire a first agent, and connect a model. That walkthrough is [Create your first company](https://docs.paperclip.ing/guides/getting-started/your-first-company/). In the app the container is labelled an "organization"; the rest of the docs still say "company".

## Prerequisites, in order

### 1. Node.js and pnpm — about 5 minutes

Install Node.js **24.11.0 or newer** and pnpm, as above. Ebbgate alone would accept Node 22, but you need 24.11+ for Paperclip.

### 2. Ollama and a model — about 10–30 minutes (mostly the download; `ebbgate init` can do it)

Ebbgate routes private and on-machine work to a local model runtime. [Ollama](https://ollama.com) is the default it checks for (`http://127.0.0.1:11434`).

Install Ollama from the official pages; do not improvise an installer:

- Download: [ollama.com/download](https://ollama.com/download)
- macOS: [docs.ollama.com/macos](https://docs.ollama.com/macos) — mount the `.dmg` and drag Ollama into `/Applications`. On first start it can add the `ollama` CLI to `/usr/local/bin`.
- Linux: [docs.ollama.com/linux](https://docs.ollama.com/linux)

Then pull a model with the official CLI (`ollama pull <model>`). See the [Ollama quickstart](https://docs.ollama.com/quickstart) for current model names. Models are several GB, so this is usually the longest step.

Or skip this step: `ebbgate init` offers to do it for you. On macOS it runs `brew install ollama && brew services start ollama` (or points you to the download page if you have no Homebrew); on Linux it runs the official install script, but only after you type yes yourself, never from `--yes`. It then pulls a small default model, `llama3.2` (about 2 GB; pick another with `--model NAME`), and records the Ollama URL and model in the `local:` section of `ebbgate.yaml`. `--yes` accepts the rest of the offer, `--no-ollama` skips it, and without a terminal (CI) nothing is installed unless you pass `--yes`.

`ebbgate doctor` later checks that Ollama is reachable and that the model from `ebbgate.yaml` is pulled.

### 3. Paperclip and an API key — about 15–30 minutes (the biggest unknown)

Complete [Before you start: install Paperclip](#before-you-start-install-paperclip) first: Node 24.11+, `npx paperclipai onboard --yes`, a company in the wizard. Then mint an API key for Ebbgate.

#### Get `PAPERCLIP_API_KEY`

Ebbgate's dispatcher calls back into the Paperclip API (to wake an agent, comment on an issue, or add a label when work is deferred). Put that credential in Ebbgate's `.env` as `PAPERCLIP_API_KEY`. It is **not** the same secret Paperclip will later send to Ebbgate's `/run` endpoint (that one is `EG_PAPERCLIP_SECRET`, generated by `ebbgate init`).

The token string is shown **once** at creation time. There is no "show token again" command. Capture it immediately into `.env` (mode 600) or your secret store.

Official ways to mint one:

1. **Connect wizard** (interactive, fastest). From the [authentication docs](https://docs.paperclip.ing/reference/cli/authentication/):

   ```bash
   npx paperclipai connect
   ```

   The wizard health-checks the instance, logs you in, lets you pick a board or agent persona, mints a token, and prints shell exports, including `PAPERCLIP_API_KEY`. Copy that value.

2. **CLI token commands**, once you already have a working CLI login. From the [token reference](https://docs.paperclip.ing/reference/cli/token/):

   ```bash
   # Board token — full board authority on the instance
   npx paperclipai token board create --name ebbgate-dispatcher

   # Agent key — scoped to one company and one agent
   npx paperclipai token agent create --company-id <company-id> --agent <agent> --name ebbgate
   ```

3. **In the Paperclip UI**, for an agent key: open any of the agent's pages and change the last part of the address to `api-keys` (for example `…/agents/ada/overview` → `…/agents/ada/api-keys`). Under **Create API Key**, type a name, click Create, and copy the token from the banner. This is documented in [Agents → API Keys](https://docs.paperclip.ing/guides/org/agents/).

`TODO(verify-paperclip)`: we have not yet confirmed against a live Paperclip whether the dispatcher needs **board** scope for wake / comment / label, or whether an **agent** API key is enough. If in doubt, mint a board token for the dispatcher (`token board create` or `connect` with the board persona).

When you run `ebbgate init`, it picks up `PAPERCLIP_API_KEY` from the environment or prompts for it, and writes it into `.env`. You can also add this line yourself afterwards, with the real token:

```bash
PAPERCLIP_API_KEY=<token-shown-once>
```

Never commit `.env`. `init` sets the file to mode 600.

### 4. Ebbgate — about 5–10 minutes (plus a short clone and build until it is on npm)

Once Node, Ollama, and Paperclip are ready, follow the **Quickstart** in the [README](../README.md). Until `ebbgate` is published to npm you need a checkout:

```bash
git clone https://github.com/patilswapnilv/ebbgate.git ~/ebbgate
(cd ~/ebbgate && pnpm install && pnpm build)
```

Ebbgate's commands work on the folder you run them in. To run the checkout's CLI from a separate working folder, point a shell alias at it:

```bash
alias ebbgate="node ~/ebbgate/packages/cli/dist/cli.js"
mkdir -p ~/ebbgate-site && cd ~/ebbgate-site
ebbgate init      # writes ebbgate.yaml (with a local: section) and .env, including EG_PAPERCLIP_SECRET
ebbgate doctor
ebbgate serve     # the dispatcher; leave it running in its own terminal
```

Once the package is on npm, the same commands are `npx ebbgate init`, `npx ebbgate doctor` and `npx ebbgate serve`, with no clone.

`init` also offers the Ollama install and model pull from step 2 if you skipped it. `serve` loads `ebbgate.yaml` and the `.env` next to it, prints the URL it listens on and the `/run` URL for Paperclip, and stops cleanly on Ctrl-C.

The Quickstart then has you install the presence agent on a Mac (`ebbgate agent install`, which by default reports to `server.publicUrl` from `ebbgate.yaml`) and point Paperclip at Ebbgate. The next section is that last step in more detail.

## Point Paperclip's `http` adapter at Ebbgate

Paperclip should POST heartbeat wakes to Ebbgate's `/run` URL, with the shared secret that `ebbgate init` wrote.

| Direction                       | Credential                                    | Where it lives                        |
| ------------------------------- | --------------------------------------------- | ------------------------------------- |
| Paperclip → Ebbgate `POST /run` | `Authorization: Bearer <EG_PAPERCLIP_SECRET>` | Ebbgate's `.env`, generated by `init` |
| Ebbgate → Paperclip API         | `Authorization: Bearer <PAPERCLIP_API_KEY>`   | same `.env`, minted in Paperclip      |

These are two different secrets. Do not swap them.

Official references (use these; do not invent field names):

- [HTTP webhook adapter](https://docs.paperclip.ing/reference/adapters/http/)
- [Bring your own agent](https://docs.paperclip.ing/how-to/bring-your-own-agent/) (Option B)
- [Agents API](https://docs.paperclip.ing/reference/api/agents/)

The `http` adapter is a built-in internal adapter. It is **not** listed in the agent form's Harness dropdown, so you cannot select it manually in the UI today. Paperclip's docs say: configure the agent via the API or an imported company export. An agent already saved with `http` keeps that harness when you edit other settings.

### Allow the local dispatcher URL

By default the HTTP adapter **rejects loopback and private addresses**, including `localhost` and `127.0.0.1`. A local Ebbgate dispatcher at `http://127.0.0.1:8790/run` will not be reached until you opt that origin in.

On the **Paperclip host**, set [PAPERCLIP_HTTP_ADAPTER_PRIVATE_ENDPOINT_ALLOWLIST](https://docs.paperclip.ing/reference/deploy/environment-variables/) to a comma-separated list of exact origins (scheme, host, and port; no path). For the default local dispatcher:

```bash
PAPERCLIP_HTTP_ADAPTER_PRIVATE_ENDPOINT_ALLOWLIST=http://127.0.0.1:8790
```

Matching is exact and case-insensitive. `http://127.0.0.1:8790` and `http://localhost:8790` are different origins — allowlist the same host and port you put in the adapter `url` (without the `/run` path). Link-local metadata addresses cannot be opted back in.

`TODO(verify-paperclip)`: official docs require this variable on the Paperclip host and say `onboard` provisions secrets into the instance's **adjacent `.env`** (next to `config.json`; the default config path is `~/.paperclip/instances/default/config.json`). We have not confirmed against a live instance that adding the allowlist line to `~/.paperclip/instances/default/.env` and restarting Paperclip (`npx paperclipai run`, or `paperclipai service restart` if you installed the service) is sufficient. If a request still never lands, re-check the [environment variables reference](https://docs.paperclip.ing/reference/deploy/environment-variables/) and the [HTTP adapter](https://docs.paperclip.ing/reference/adapters/http/) "Private vs public endpoints" section.

### Configure the adapter

The documented config shape (from the HTTP adapter reference), pointed at Ebbgate:

```json
{
  "adapterType": "http",
  "adapterConfig": {
    "url": "http://127.0.0.1:8790/run",
    "method": "POST",
    "headers": {
      "Authorization": "Bearer <EG_PAPERCLIP_SECRET from your Ebbgate .env>"
    },
    "timeoutMs": 10000
  }
}
```

To apply it, use the documented API with a **board** token (or whatever credential your Paperclip login uses). Examples below follow the official [bring-your-own-agent](https://docs.paperclip.ing/how-to/bring-your-own-agent/) and [Agents API](https://docs.paperclip.ing/reference/api/agents/) pages. Substitute your API base (default `http://localhost:3100`), company id, and agent id. Do not put the secret in a file you will commit.

Create (hire) a new agent, as in the official how-to (`POST /api/companies/{companyId}/agent-hires`):

```bash
# EG_PAPERCLIP_SECRET is the value from Ebbgate's .env, not PAPERCLIP_API_KEY
curl -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/agent-hires" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"Ebbgate Worker\",
    \"role\": \"engineer\",
    \"adapterType\": \"http\",
    \"adapterConfig\": {
      \"url\": \"http://127.0.0.1:8790/run\",
      \"method\": \"POST\",
      \"headers\": { \"Authorization\": \"Bearer ${EG_PAPERCLIP_SECRET}\" },
      \"timeoutMs\": 10000
    }
  }"
```

Or update an existing agent (`PATCH /api/agents/{agentId}`):

```bash
curl -s -X PATCH \
  "$PAPERCLIP_API_URL/api/agents/$AGENT_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"adapterType\": \"http\",
    \"adapterConfig\": {
      \"url\": \"http://127.0.0.1:8790/run\",
      \"method\": \"POST\",
      \"headers\": { \"Authorization\": \"Bearer ${EG_PAPERCLIP_SECRET}\" },
      \"timeoutMs\": 10000
    }
  }"
```

`TODO(verify-paperclip)`: the hire and PATCH endpoints and the `adapterConfig` fields above are documented. We have not yet run this exact payload against a live Paperclip to confirm a hire-or-edit of an existing first-agent works end to end with Ebbgate, including whether `timeoutMs` of 10000 is enough for a deferred `202`. The [bring-your-own-agent](https://docs.paperclip.ing/how-to/bring-your-own-agent/) guide also says to store the webhook secret as a Paperclip secret rather than in the JSON config; the exact `secret_ref` shape for `headers` is not shown there, so this page keeps the documented plaintext-header example.

Paperclip expects a **2xx** from `/run` when the wake was accepted, not when the work has finished. Ebbgate returns 2xx (including `202` when a task is deferred). If a request never lands, the agent's adapter has a **Test Environment** button that sends a `HEAD` probe; a private origin must still be on the allowlist or the real request is rejected before it connects.

Admission-based environment overflow (`ebbgate admit`, proposed in [paperclip#17402](https://github.com/paperclipai/paperclip/pull/17402)) is a separate, still-unmerged path. See [`paperclip-admission.md`](./paperclip-admission.md).

## Check the setup

From the folder with `ebbgate.yaml` and `.env`:

```bash
npx ebbgate doctor
# or, from a checkout: pnpm ebbgate doctor
```

Work through FAIL lines until they are gone. `doctor` checks Node, the config, `.env` permissions, the dispatcher, presence, Ollama, the queue, and Paperclip reachability. It never prints a secret.

## Time, at a glance

| Step                                          | Rough time        | Notes                                                                           |
| --------------------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| Node.js 24.11+ and pnpm                       | ~5 minutes        | Required by Paperclip; also covers Ebbgate                                      |
| Ollama + a model                              | ~10–30 minutes    | Almost all of this is the model download                                        |
| Paperclip + API key                           | ~15–30 minutes    | Biggest unknown; not timed here                                                 |
| Ebbgate (init, doctor, serve, agent, adapter) | ~5–10 minutes     | Plus ~3–5 minutes to clone and build, until the package is on npm               |
| **Total from a clean machine**                | **about an hour** | The README "Quickstart (5 minutes)" starts after these prerequisites            |
| Demo only (`ebbgate demo`)                    | ~1–10 minutes     | No Paperclip, Ollama, or keys; longer only if you still have to clone and build |

## Official sources

- Paperclip: [paperclip.ing](https://paperclip.ing), [installation](https://docs.paperclip.ing/guides/getting-started/installation/), [CLI installation](https://docs.paperclip.ing/reference/cli/installation/), [first company](https://docs.paperclip.ing/guides/getting-started/your-first-company/), [authentication](https://docs.paperclip.ing/reference/cli/authentication/), [token commands](https://docs.paperclip.ing/reference/cli/token/), [Agents / API Keys](https://docs.paperclip.ing/guides/org/agents/), [HTTP adapter](https://docs.paperclip.ing/reference/adapters/http/), [environment variables](https://docs.paperclip.ing/reference/deploy/environment-variables/), [bring your own agent](https://docs.paperclip.ing/how-to/bring-your-own-agent/), [GitHub repo / INSTALLING.md](https://github.com/paperclipai/paperclip/blob/HEAD/doc/INSTALLING.md)
- Ollama: [download](https://ollama.com/download), [macOS](https://docs.ollama.com/macos), [Linux](https://docs.ollama.com/linux), [quickstart](https://docs.ollama.com/quickstart)
- Ebbgate: [README Quickstart](../README.md)

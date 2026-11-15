# ZCode Bridge 🌉

**OpenAI-compatible model provider bridge that runs Hermes Agent (or any OpenAI client) on your Z.ai ZCode plan quota — with full tool/skill support.**

پل OpenAI-compatible که هرمس (یا هر کلاینت OpenAI) را روی کوتی اشتراک ZCode شما اجرا می‌کند — با پشتیبانی کامل ابزارها.

---

## What it does

This bridge is a **real model provider** (not a text-only shim):

```
Hermes Agent (system prompt + tools + history)
   → bridge: OpenAI ⇄ Anthropic translation
      → zcode.z.ai zcode-plan endpoint (GLM-5.3-Flash, your plan quota)
   → tool_calls returned in OpenAI format
→ Hermes's own agent loop runs untouched: tools, skills, memory, streaming
```

It works by speaking the **exact protocol of the official ZCode client** to the
`zcode.z.ai/api/v1/zcode-plan/anthropic` endpoint (ZCode JWT auth, device-mid,
version headers, the official system prompt, `thinking`/`output_config`
fields), which is what the endpoint's anti-abuse layer expects.

## Requirements

- macOS (tested) or Linux; **Node.js ≥ 20**
- A Z.ai account with an active **ZCode plan** (e.g. the "ZCode Weekend Build"
  start plan) — log in inside the ZCode desktop app once so the plan is active
- Python 3 (only for the account wizard's one-time credential injection)
- [Hermes WebUI](https://github.com/NousResearch/hermes-agent) (optional — any
  OpenAI-compatible client works)

## Setup

```bash
# 1. build the patched ZCode CLI (clones the open-source repo, applies the patch)
./build-cli.sh

# 2. add your Z.ai account (opens a browser login)
./add-account.sh my-account

# 3. run the bridge (port 20145)
node bridge.mjs
```

To run it as a persistent service on macOS, copy
`com.ardalan.zcode-bridge.plist` to `~/Library/LaunchAgents/` and
`launchctl load` it.

### Connect Hermes

In `~/.hermes/config.yaml`:

```yaml
custom_providers:
- name: ZCodeBridge
  base_url: http://127.0.0.1:20145/v1
  api_key: zbridge-local
  model: glm-5.3-flash
  models:
  - id: glm-5.3-flash
    label: GLM 5.3 Flash (ZCode plan)
```

Then pick the model in the chat's model picker. New conversations keep their
previous default — switch the model once per conversation.

### Multi-account

Run `./add-account.sh <another-id>` for each additional Z.ai account. The
bridge round-robins requests across all accounts and fails over to the next
account on auth errors.

## How the pieces work

| file | purpose |
|---|---|
| `bridge.mjs` | Node HTTP server: OpenAI ⇄ Anthropic translation, tools, SSE streaming, account rotation |
| `add-account.sh` | wizard: OAuth login → registers the Start-Plan identity → verification prompt |
| `build-cli.sh` | clones [zai-org/ZCode](https://github.com/zai-org/ZCode), applies `start-plan.patch`, builds the CLI |
| `start-plan.patch` | 2 small patches: teach the headless CLI about Start-Plan providers and use the shared ZCode JWT as the request credential |
| `zcode-system.json` | the official agent system prompt (extracted from the OSS CLI) — the endpoint requires requests to carry it verbatim |

## Notes & limitations

- **Unofficial endpoint.** This talks to Z.ai's internal `zcode-plan` API — it
  can change or be restricted at any time, and heavy automated use may violate
  Z.ai's terms of service. Use your own account, at your own risk.
- The ZCode JWT from the login expires (~24 h). When the bridge starts failing
  with auth errors, re-run `./add-account.sh <id>` to refresh.
- Each request carries the official agent system prompt (cache makes repeats
  cheap — typically ~1–3 K billed tokens per turn).
- Tool use is passed through to the caller (Hermes executes tools locally).
  The bridge itself never executes anything on your machine.
- Only the **Start Plan** kind is supported headlessly (the upstream CLI
  defaults to Individual Coding Plan, which needs a GLM Coding Plan
  subscription).

## License

MIT — see [LICENSE](LICENSE). ZCode is © Z.ai and licensed Apache-2.0; this
project only interoperates with it and is not affiliated with Z.ai.

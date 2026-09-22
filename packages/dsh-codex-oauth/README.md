# dsh-codex-oauth

Use your **OpenAI Codex subscription** (ChatGPT Plus/Pro) inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — via OAuth, the same way the official Codex CLI and other harnesses do.

The upstream harness's multi-provider adapter deliberately withholds `openai-codex` because Codex authenticates through ChatGPT OAuth, and that adapter holds no credential store and runs no login flow. This community plugin supplies both pieces as an installable bundle: a file-backed OAuth credential store, a `/codex login` human command, and a `codex` provider route registered on the public LLM seam.

- Built on the published seam packages (`@deepseek-ai/dsh-llm`, `@deepseek-ai/cordis`) — no fork, no core change.
- pi-ai's provider-owned Codex OAuth flows handle the wire protocol: browser login with a local callback server, headless device-code login, and automatic refresh under a cross-process credential-store lock.
- Tokens live in `$DSH_HOME/codex-oauth.json` (`0600`, owner-only directory), the same place the CLI bin and the harness plugin both read.

## Requirements

- A ChatGPT **Plus or Pro** subscription. (A plain OpenAI platform API key does not work — subscription access is bound to your ChatGPT account, not an API key.)
- DeepSeek Harness installed (`npx @deepseek-ai/dsh web` or a source checkout).

## Install

One command installs the bundle into the `web` profile (it writes the one-time pnpm build approvals and runs `dsh plugin add` for you):

```sh
npx --yes https://github.com/birat-chapagain/dsh-codex-oauth/releases/download/v0.1.6/dsh-codex-oauth.tgz install
```

Then restart `dsh web` and run `/codex login` once.

Manual alternatives (same effect, both use prebuilt artifacts with no build permission):

```sh
dsh plugin --profile web add https://github.com/birat-chapagain/dsh-codex-oauth/releases/download/v0.1.6/dsh-codex-oauth.tgz
# or, from git (pin a commit for reproducibility: github:…/…#<sha>):
dsh plugin --profile web add github:birat-chapagain/dsh-codex-oauth
```

pnpm 11.22+ hard-fails when any transitive dependency has an unapproved build script — pi-ai's tree carries two (`@google/genai`, `protobufjs`, both unused by the Codex route). The one-command installer approves exactly those packages, repairs their `set this to true or false` placeholders, and preserves every unrelated `allowBuilds` value, including explicit denials. A manual install that ends with `ERR_PNPM_IGNORED_BUILDS` just needs this one-time snippet in the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@google/genai': true
  protobufjs: true
```

(If pnpm prints different exact keys in its error, use those — the printed keys are authoritative.)

### Expected peer-dependency warning

pnpm may report `@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`, or `@deepseek-ai/dsh-invariants` as missing peers. This bundle is a Harness plugin: Harness supplies those packages from the host installation, while the profile intentionally sets `autoInstallPeers: false`. pnpm checks only the profile's package graph and cannot see the host packages that Harness makes available when it loads plugins.

The warning alone is not an installation failure. Do not add duplicate Cordis, LLM, or invariants packages to the profile to silence it; duplicate host packages can create separate plugin contexts or service instances. Confirm the installation with `dsh --profile web --dump-config`, then start `dsh web`; investigate the warning only if either command fails or pnpm names a different missing package.

The profile manifest ends up listing the bundle after `@deepseek-ai/dsh-base`; verify the composed tree without booting:

```sh
dsh --profile web --dump-config
```

## Log in

Logging in is a **human command**, not a model tool — it never enters a prompt.

### Web UI

Type `/codex login` in the chat input. A browser window opens on the ChatGPT authorization page; complete it, and the command reports when the token is stored. Use `/codex logout` and `/codex status` to manage it. Device login needs instructions while authentication is pending, but a human command returns only one final result, so `/codex login device` immediately directs you to the CLI command below instead of starting a flow whose code the UI cannot show.

### Headless / CLI

The bundle also ships a `dsh-codex-oauth` bin that runs outside the harness (the headless profile has no command plane):

```sh
npx dsh-codex-oauth login                 # browser flow (desktop)
npx dsh-codex-oauth login --method device # device-code flow (headless)
npx dsh-codex-oauth status
npx dsh-codex-oauth logout
```

Device flow prints a one-time code plus the OpenAI device-verification URL; enter the code on any device, and the CLI waits until you authorize and stores the token in the same file the harness reads.

## Use Codex

The plugin registers provider route **`codex`** with the Codex catalog models. The repository build keeps pi-ai 0.85.1 for transport compatibility and backfills the upstream GPT-6 Sol (`gpt-6-sol`) and GPT-6 Luna (`gpt-6-luna`) model metadata from pi-ai 0.87.1; both advertise text + image input. Select `codex` / a Codex model in the Web model picker, or set the default for a headless profile in the profile's `cordis.patch.yml`:

```yaml
- id: agent-default-model
  config:
    provider: codex
    model: gpt-5.4
```

Per-session selection in the Web UI needs no patch. Provider, model, and capabilities resolve through the same LLM seam as shipped providers; prompts, tools, persistence, and history replay behave identically.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `provider` | `codex` | Provider route id the adapter registers. |
| `storePath` | `$DSH_HOME/codex-oauth.json` | OAuth credential store location. |
| `transport` | `sse` | Codex Responses transport: `sse`, `websocket`, `websocket-cached`, or `auto`. `sse` exits cleanly after one-shot headless turns; `websocket`/`websocket-cached` reuse the connection for long interactive sessions but keep one-shot processes alive. |
| `cacheRetention` | `long` | pi-ai prompt-cache retention: `none`, `short`, `long`. |
| `streamIdleTimeoutMs` | `300000` | Maximum milliseconds without a provider stream event while a read is pending. A timeout aborts the SDK stream and returns a `TIMEOUT` LLM failure. |

Override in a later patch layer (profile `cordis.patch.yml` replaces this row's whole `config`):

```yaml
- id: codex-oauth
  config:
    provider: codex
    transport: sse
```

## Security notes

- The store document is written atomically with `0600` permissions under a `0700` directory, and a group/world-readable document is refused on POSIX. It holds your ChatGPT OAuth tokens — treat it like an API key.
- The harness process and its tool subprocesses run as your user; like the upstream credentials document, this file is not hidden from tools the model can drive. Do not point the model's workspace at your Harness home.
- Only `https` URLs issued by the login flow are ever handed to the browser opener. A missing or failing OS opener is reported without terminating the harness; the CLI still prints the URL for manual use.
- The login flow is pi-ai's provider-owned implementation (authorization-code + device-code against `chatgpt.com`); this plugin answers its interaction prompts and stores the result.

## How it works

- `src/store.ts` — `FileCredentialStore`, a persistent pi-ai `CredentialStore` with serialized read-modify-write (`dsh-atomic-write`).
- `src/auth.ts` — login/status/logout over pi-ai's `openai-codex` OAuth provider.
- `src/catalog.ts` — a narrow catalog backfill for GPT-6 Sol/Luna; existing pi-ai entries win, so the shim becomes inert after a future catalog upgrade.
- `src/adapter.ts` — `CodexAdapter extends LlmAdapter` (from `@deepseek-ai/dsh-llm`), registered with `ctx.llm.registerAdapter(['codex'], …)`; `stream()` resolves/refreshes auth through pi-ai, enforces provider-idle timeout, and aborts SDK work when its consumer stops.
- `src/convert.ts` — request/stream vocabulary conversion, adapted from `@deepseek-ai/dsh-llm-pi-ai` (MIT, © DeepSeek AI) with image attachment support and provider-native replay state omitted.
- `src/index.ts` — the Cordis function plugin (`name`/`inject`/`Config`/`apply`); registers the adapter and, when the composition mounts `ctx.commands`, the `/codex` command.

## Limitations

- **Image input follows the pi-ai catalog.** User images are sent only when the selected model advertises image input, through Harness's attachment service and the same request-image conversion used by `dsh-llm-pi-ai`. The supported formats are PNG, JPEG, WebP, and GIF. Historical assistant image output remains unsupported.
- **No browser Models-page card.** Configuration happens through the patch layer and the picker lists the route through the adapter registry; login is the bin or `/codex` command, not the credentials page.
- **No provider-native replay state.** Historical assistant messages replay as provider-neutral content (correct, but without signature/cache reuse).
- **Browser login assumes a desktop browser.** Machines without one run `dsh-codex-oauth login --method device` in a terminal.
- **One browser login at a time.** The OAuth callback uses one local port; wait for one browser flow to finish before starting another. The store lock separately serializes credential writes.

## Development

```sh
npm install
npm test        # builds lib/ then runs the unit tests
```

The unit tests cover catalog modalities, Harness-to-pi-ai image conversion, and unchanged text-only requests.

## License

MIT. The conversion modules in `src/convert.ts` are adapted from `@deepseek-ai/dsh-llm-pi-ai` (MIT, © DeepSeek AI).

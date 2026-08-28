/**
 * dsh-codex-oauth: use your OpenAI Codex (ChatGPT Plus/Pro) subscription in
 * DeepSeek Harness through OAuth.
 *
 * The plugin registers one `LlmAdapter` for a `codex` provider route backed
 * by pi-ai's `openai-codex` provider, whose OAuth credential lives in a
 * `0600` JSON store under the Harness home. When the composition mounts the
 * commands service, it also registers the `/codex` human command; headless
 * users authenticate through the `dsh-codex-oauth` CLI bin instead.
 *
 * @module dsh-codex-oauth
 */
import Schema from '@deepseek-ai/schemastery';
import { createModels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { CodexAdapter } from './adapter.js';
import { codexCommand } from './command.js';
import { FileCredentialStore } from './store.js';
export const name = 'dsh-codex-oauth';
/** The LLM seam is the one required service; the adapter works in every composition. */
export const inject = ['llm'];
/** Default maximum interval without a Codex stream event while a read is pending. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
export const Config = Schema.object({
    provider: Schema.string().default('codex'),
    storePath: Schema.string(),
    transport: Schema.union(['sse', 'websocket', 'websocket-cached', 'auto']).default('sse'),
    cacheRetention: Schema.union(['none', 'short', 'long']).default('long'),
    streamIdleTimeoutMs: Schema.number()
        .min(Number.MIN_VALUE)
        .max(MAX_TIMER_DELAY_MS)
        .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
});
export function apply(ctx, config) {
    const store = new FileCredentialStore(config.storePath ?? dshHomePath('codex-oauth.json'));
    const models = createModels({ credentials: store });
    models.setProvider(openaiCodexProvider());
    const adapter = new CodexAdapter(models, config.provider, {
        transport: config.transport,
        cacheRetention: config.cacheRetention,
        streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    });
    // Registrations are effects: HMR and fiber teardown unwind both.
    ctx.effect(() => ctx.llm.registerAdapter([config.provider], adapter));
    const commands = ctx.get('commands');
    if (commands !== undefined) {
        ctx.effect(() => commands.register(codexCommand(store)));
    }
}
//# sourceMappingURL=index.js.map
import type { Context } from '../context-types.ts';
import type { SidebarStore } from './state.ts';
/** Consume host-only user presentation frames; this does not alter model tools. */
export declare function usePresentationFeed(input: {
    ctx: Context;
    store: SidebarStore;
    sessionId: string | undefined;
}): void;

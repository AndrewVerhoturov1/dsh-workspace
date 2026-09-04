import { type SessionScope } from './api.ts';
import type { SidebarStore } from './state.ts';
export declare function useWorkspaceRoot(store: SidebarStore): string | undefined;
export declare function setWorkspaceRoot(store: SidebarStore, workspaceRoot: string | undefined): void;
/** Shared Files/Source Control selector. It only changes store state. */
export declare function WorkspaceTargetSelect(props: {
    scope: SessionScope;
    store: SidebarStore;
}): JSX.Element | null;

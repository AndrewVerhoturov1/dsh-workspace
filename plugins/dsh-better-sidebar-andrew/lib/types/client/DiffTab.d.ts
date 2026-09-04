import type { SidebarDiffRef } from './state.ts';
export declare function DiffTab(props: {
    sessionId: string;
    cwd: string | undefined;
    workspaceRoot?: string;
    diff: SidebarDiffRef;
}): import("react").JSX.Element;

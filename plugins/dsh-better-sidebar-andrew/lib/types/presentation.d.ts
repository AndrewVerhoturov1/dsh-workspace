import type { BetterSidebarPresentationService, SidebarPresentationRequest, SidebarPresentationWireRequest } from './context-types.ts';
type Sender = (request: SidebarPresentationWireRequest) => void;
type EnqueueRequest = ({
    action: 'present';
} & SidebarPresentationRequest) | {
    action: 'clear';
    sessionId: string;
    workspaceRoot?: string;
};
export declare class SidebarPresentationRegistry {
    private pending;
    private subscribers;
    enqueue(request: EnqueueRequest): {
        id: string;
        delivered: boolean;
    };
    attach(sessionId: string, send: Sender): () => void;
    dispose(): void;
}
export declare function createBetterSidebarPresentationService(options: {
    registry: SidebarPresentationRegistry;
    resolveSessionCwd: (sessionId: string) => Promise<string>;
}): BetterSidebarPresentationService;
export {};

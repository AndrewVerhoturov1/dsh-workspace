/** Path-encoded HTML preview routes, with an optional encoded worktree root. */
export interface HtmlRouteRef {
    sessionId: string;
    path: string;
    workspaceRoot?: string;
}
export type HtmlDecodeResult = {
    ok: true;
    ref: HtmlRouteRef;
} | {
    ok: false;
    status: 400 | 404;
    message: string;
};
export declare const HTML_ROUTE_PREFIX = "/sidebar/html/";
export declare const HTML_WORKSPACE_ROUTE_PREFIX = "/sidebar/workspace-html/";
export declare function encodeHtmlUrl(sessionId: string, path: string, workspaceRoot?: string): string;
export declare function decodeHtmlUrl(pathname: string): HtmlDecodeResult;

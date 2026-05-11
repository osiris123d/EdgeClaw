/**
 * Shared MCP OAuth popup completion HTML handler (MainAgent + ToolAgent DOs).
 */

type OAuthResult = { authSuccess: boolean; authError?: string };

type McpOAuthConfigureHost = {
  mcp?: {
    configureOAuthCallback?: (opts: {
      customHandler: (result: OAuthResult) => Response;
    }) => void;
  };
};

/**
 * Installs the EdgeClaw MCP OAuth callback handler so browser popups close and postMessage to the opener.
 */
export function configureEdgeClawMcpOAuthPopupClose(host: object): void {
  const sdkMcp = (host as McpOAuthConfigureHost).mcp;

  if (typeof sdkMcp?.configureOAuthCallback !== "function") {
    return;
  }

  sdkMcp.configureOAuthCallback({
    customHandler: (result: OAuthResult) => {
      const success = result.authSuccess === true;
      if (!success) {
        console.warn(
          "[EdgeClaw][mcp] OAuth callback received failure result. " +
            "Server will remain in authenticating state until user retries."
        );
      }
      const html = success
        ? [
            "<!DOCTYPE html>",
            "<html><head><meta charset=utf-8>",
            "<title>Authorization Complete</title>",
            "<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc}",
            ".card{text-align:center;padding:2rem;border-radius:12px;background:#fff;box-shadow:0 2px 16px rgba(0,0,0,.1)}",
            "h2{color:#16a34a;margin:0 0 .5rem}p{color:#64748b;margin:0}</style>",
            "</head><body><div class=card>",
            "<h2>&#10003; Authorized</h2>",
            "<p>This window will close automatically&hellip;</p>",
            "</div>",
          ].join("")
        : [
            "<!DOCTYPE html>",
            "<html><head><meta charset=utf-8>",
            "<title>Authorization Failed</title>",
            "<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc}",
            ".card{text-align:center;padding:2rem;border-radius:12px;background:#fff;box-shadow:0 2px 16px rgba(0,0,0,.1)}",
            "h2{color:#dc2626;margin:0 0 .5rem}p{color:#64748b;margin:0}</style>",
            "</head><body><div class=card>",
            "<h2>&#10007; Authorization failed</h2>",
            "<p>Please close this window and try again from the Settings panel.</p>",
            "</div>",
          ].join("");

      return new Response(
        html +
          [
            "<script>",
            "(function(){",
            `try{if(window.opener&&!window.opener.closed){`,
            `window.opener.postMessage({type:'mcp-oauth-complete',success:${success}},window.location.origin);`,
            "}}catch(e){}",
            "setTimeout(function(){window.close();},800);",
            "})();",
            "</script></body></html>",
          ].join(""),
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    },
  });
  console.log("[EdgeClaw][mcp] OAuth callback configured: popup-close mode (success+failure).");
}

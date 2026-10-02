import { ArrowDownToLine, ExternalLink } from "lucide-react";
import hearthApps from "../plugins/hearth/.app.json";

const releases = "https://github.com/joe5saia/hearth/releases/latest";

export function ChatGPTSetup() {
  return (
    <div className="chatgpt-setup">
      <p>
        Plan meals, organize recipes, and prepare your shopping list in a conversation. Hearth’s plugin
        includes guided workflows and connects to your shared household.
      </p>
      <div className="chatgpt-actions">
        <a className="primary" href={`${releases}/download/hearth-chatgpt.zip`}>
          <ArrowDownToLine size={17} /> Download ChatGPT ZIP
        </a>
        <a href={releases} target="_blank" rel="noreferrer">
          Release notes & checksums <ExternalLink size={14} />
        </a>
      </div>
      <p className="chatgpt-notice">
        Requires ChatGPT plugin upload permission and an authorized Hearth household account. Installing the
        ZIP does not grant access. Saved changes affect everyone in the household.
      </p>
      <h3>Install on ChatGPT web</h3>
      <ol>
        <li>
          Download <strong>hearth-chatgpt.zip</strong> above. Use the release asset, not the source-code ZIP
          or the desktop-only portable package.
        </li>
        <li>
          In ChatGPT, open <strong>Admin → Plugins → Add → Upload plugin</strong> and select the ZIP. If
          upload is missing, ask your workspace administrator.
        </li>
        <li>
          Open the{" "}
          <a
            href={`https://chatgpt.com/plugins/plugin_${hearthApps.apps.hearth.id}`}
            target="_blank"
            rel="noreferrer"
          >
            registered Hearth connection
          </a>
          , make it available to your workspace, and connect with your household Google sign-in. Review the
          read/write permissions before allowing access.
        </li>
        <li>
          Install Hearth from{" "}
          <a href="https://chatgpt.com/plugins" target="_blank" rel="noreferrer">
            ChatGPT Plugins
          </a>
          . Start a new <strong>Work</strong> chat, mention <strong>@Hearth</strong>, and try “Show my saved
          recipes” before asking it to make changes.
        </li>
      </ol>
      <details>
        <summary>Update an existing plugin</summary>
        <p>
          Download the latest ZIP, open Hearth’s plugin details, and choose{" "}
          <strong>Upload new version</strong>. Keep the same app connection and test in a new chat. GitHub
          releases do not update ChatGPT automatically. GitHub-managed plugins must update through their
          configured source.
        </p>
      </details>
      <details>
        <summary>First-time connection or no upload access?</summary>
        <p>
          Enable <strong>Developer mode</strong> in ChatGPT’s <strong>Settings → Security and login</strong>.
          Open Plugins, select the plus button, and register this MCP endpoint with OAuth:
        </p>
        <code>https://hearth-mcp.joesaia.trade/mcp</code>
        <p>
          Use the registered connection above when available. A separate registration in another workspace
          needs a web ZIP referencing its own app ID; ask the maintainer to configure it. The MCP-only
          connection works without the ZIP, but does not include the bundled skills.
        </p>
      </details>
      <p className="chatgpt-help">
        The server stays hosted by Hearth; no local server is needed. Grocery ordering, nutrition analysis,
        and kitchen timers are not supported through the plugin. Never paste sign-in credentials into chat.
        See the{" "}
        <a
          href="https://github.com/joe5saia/hearth/blob/main/plugins/hearth/README.md"
          target="_blank"
          rel="noreferrer"
        >
          full installation guide
        </a>
        .
      </p>
    </div>
  );
}

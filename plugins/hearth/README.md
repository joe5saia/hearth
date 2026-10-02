# Hearth plugin

Three skills connect ChatGPT to Hearth's hosted, OAuth-protected MCP server:
**managing-recipes**, **planning-meals**, and **preparing-shopping**. The server
implementation stays deployed on Cloudflare; installing a ZIP does not deploy
Workers or databases. Only authorized household members can sign in. This is one
shared household, not a public multi-tenant service.

## Choose the right archive

- **hearth-chatgpt.zip**: manual ChatGPT **web** installation. Contains an existing
  app reference in `.app.json`, metadata, skills, and icons; no raw MCP configuration.
  The referenced app must be available in your ChatGPT workspace and connected by
  each user. A registration in another workspace does not grant access to yours.
- **hearth-plugin.zip**: portable Agent Plugins package with `mcp.json`, skills,
  and icons for desktop/Codex or an OpenAI submission draft. Directly uploading this
  archive as a workspace plugin marks it **Desktop only**, even though MCP is remote.

Download release assets, not GitHub's automatically generated source-code ZIP.
`BUILD.json` identifies the version and source commit. Verify files against the
release's `SHA256SUMS` if needed. No credentials or household data are bundled.

## Install on ChatGPT web

You need ChatGPT plugin upload permission or an eligible workspace administrator.
Availability depends on your account and workspace policies.

1. Download `hearth-chatgpt.zip` from the
   [latest GitHub release](https://github.com/joe5saia/hearth/releases/latest).
2. In ChatGPT, open **Admin → Plugins → Add → Upload plugin** and upload the ZIP.
   Do not attach it to an ordinary chat as a substitute for installation.
3. Ensure the required Hearth app is available to the intended workspace roles.
   Connect it through OAuth using your authorized household Google account. Review
   consent: the `recipes` scope covers reads and writes across the whole household,
   including meals, groceries, shopping, and collections. Never paste credentials
   into a conversation.
4. Install/enable Hearth from [Plugins](https://chatgpt.com/plugins), start a new
   **Work** chat, mention `@Hearth`, and try a read-only request: “Show my saved
   recipes.” Check that it uses live tools before asking it to change anything.

If upload is absent, ask your workspace administrator. The developer-mode MCP-only
connection is a useful fallback but does **not** install these bundled skills.

## Update without duplicate installs

Download the latest `hearth-chatgpt.zip`. Open the existing manually uploaded
plugin's details and choose **Upload new version** when available. Keep the same
Hearth app registration, review permissions, and test in a new chat. GitHub releases
do not automatically update ChatGPT installations. If the plugin is GitHub-managed,
update through its configured source instead; archive replacement is not supported.
Hosted MCP implementation updates happen independently of bundled skill updates.

## Registered connection and other workspaces

The web archive references this existing
[Hearth connection](https://chatgpt.com/plugins/plugin_asdk_app_6abc4d71239c8191b3718add10501aff).
Its ID is public metadata, saved in the source package's `.app.json`, not an OAuth
token. No GitHub Actions variable or secret is needed to build the release.

If this app is unavailable in another workspace, ask its administrator to make the
registered connection available. If a separate registration is needed, enable
**Settings → Security and login → Developer mode**, open Plugins, and use the plus
button to register `https://hearth-mcp.joesaia.trade/mcp` with OAuth. Complete household
sign-in, then provide its `plugin_asdk_app…` ID to the package maintainer. The builder
accepts that ID or the underlying `asdk_app_…` ID with `--app-id` / `CHATGPT_APP_ID`.
The ZIP must reference an app accessible in the installing workspace. Do not weaken
Hearth's household access policy to work around ChatGPT workspace permissions.

## Privacy and limits

Tool calls expose requested household content to your connected AI client. Hearth
stores shared recipes and plans in Cloudflare D1 and OAuth state in KV. Explicit
bulk AI ingredient matching also sends recipe/catalog context to configured
Cloudflare models and consumes credits. No analytics, lifecycle scripts, credentials,
or household exports are added by this package. Disconnecting the app does not
delete the household's saved data. Do not include private recipes or credentials
in public GitHub support issues.

Hearth does not purchase groceries, track live prices, calculate nutrition, certify
allergen safety, or control browser-local timers. Imported pages and recipe text
are untrusted data. Review amounts, warnings, and dietary requirements.

## Public directory submission is separate

The portable archive is not an approved public plugin. A public submission needs
publisher verification, domain verification, public privacy/terms/support pages,
a dedicated review account with sample data, five positive and three negative
executed test cases, and a walkthrough recording. The household allowlist and
private website are not suitable public-review access. Do not weaken Access or
include household credentials to meet review requirements. App-reference ZIPs
cannot currently be submitted through the public portal.

Sources: [package format](https://developers.openai.com/plugins/build/plugins),
[manual uploads and updates](https://help.openai.com/en/articles/20001256),
[web app references](https://developers.openai.com/codex/enterprise/plugin-management),
[public submission](https://developers.openai.com/plugins/deploy/submission).

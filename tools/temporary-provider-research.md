# Temporary-mode verification evidence

Checked 2026-11-01 using public, signed-out resources. No account or chat messages were used.

[Google's Gemini help](https://support.google.com/gemini/answer/13275745?hl=en) distinguishes the control that starts Temporary chat from the icon shown at the top while it is active. It requires a personal signed-in account.

The public English Gemini app bundle fetched from `gemini.gstatic.com` has SHA256 `8f927e1618c06bcb2bfbc32b67490281ee545240480ab26c7ec2fc610582d231` (3,384,761 characters). Its compiled component metadata declares `Qa:[["chat-window"]]`. That component's host binding includes `("is-temporary-chat",b.Hgb&&b.isTemporaryChat())`. This class is derived from the active conversation state and a feature flag, rather than from the navigation button's presence. The same bundle's conversation store selector reads `a.isTemporaryChat`.

Use the actual provider composer's closest `chat-window` host, with a visible composer and signed-in state. A reply element, hidden host, navigation item, requested-mode variable or arbitrary text must not confirm Temporary mode. A missing class or unknown UI variant is unconfirmed and must fail closed. The feature flag means absence does not prove the page is normal.

Raw public HTML, downloaded bundle, versioned source URL and bounded excerpts are preserved locally in `.tmp/gemini-temp-source/evidence.json`, `manifest.json` and `bundle-10.js`. The source URL can be recovered from that manifest without accessing any account.

This is source evidence for synthetic positive/negative detector tests. It does not establish a live signed-in Temporary conversation, server retention policy or compatibility with every provider rollout. Native acceptance must separately verify the pre-upload check and explicit send intent, using isolated provider stubs and no remote uploads.

# Temporary-mode verification evidence

Checked 2026-11-01 using public, signed-out resources. No account or chat messages were used.

[Google's Gemini help](https://support.google.com/gemini/answer/13275745?hl=en) distinguishes the control that starts Temporary chat from the icon shown at the top while it is active. It requires a personal signed-in account.

The public English Gemini app bundle fetched from `gemini.gstatic.com` has SHA256 `8f927e1618c06bcb2bfbc32b67490281ee545240480ab26c7ec2fc610582d231` (3,384,761 characters). Its compiled component metadata declares `Qa:[["chat-window"]]`. That component's host binding includes `("is-temporary-chat",b.Hgb&&b.isTemporaryChat())`. This class is derived from the active conversation state and a feature flag, rather than from the navigation button's presence. The same bundle's conversation store selector reads `a.isTemporaryChat`.

Use the actual provider composer's closest `chat-window` host, with a visible composer and signed-in state. A reply element, hidden host, navigation item, requested-mode variable or arbitrary text must not confirm Temporary mode. A missing class or unknown UI variant is unconfirmed and must fail closed. The feature flag means absence does not prove the page is normal.

Raw public HTML, downloaded bundle, versioned source URL and bounded excerpts are preserved locally in `.tmp/gemini-temp-source/evidence.json`, `manifest.json` and `bundle-10.js`. The source URL can be recovered from that manifest without accessing any account.

This is source evidence for synthetic positive/negative detector tests. It does not establish a live signed-in Temporary conversation, server retention policy or compatibility with every provider rollout. Native acceptance must separately verify the pre-upload check and explicit send intent, using isolated provider stubs and no remote uploads.

## Atomic attachment handoff experiment

A second worker audit identified a real check/use gap if native CDP assigns files directly to the provider input after an asynchronous mode check. Root verified a detached-input alternative in headless Edge and the actual hidden native WebView2: 10 checks passed in each. These are architecture experiments, not validation of a finished bridge implementation. Reproducers and logs are `.tmp/detached-file-probe.mjs`, `.tmp/detached-native-probe.mjs`, `.tmp/O20-detached-boundary-proof.log` and `.tmp/O20-detached-native-proof.log`.

CDP `DOM.setFileInputFiles` accepts the `objectId` of a detached input, obtained with `Runtime.evaluate` and `returnByValue:false`. Its file selection does not reach listeners on the provider's connected input or appear in document queries. The bridge can retain that detached node in a turn-scoped closure, without connecting it to the DOM.

The final commit must be synchronous: verify current actual Temporary mode and the captured real input's identity/connectivity; clone the detached files through a fresh `DataTransfer`; assign that cloned FileList to the real input; dispatch input/change; clear the detached node. There must be no await between the final mode check and the provider event dispatch. A simulated mode change after CDP population but before commit rejected with no provider files/events. The successful path delivered exact binary bytes.

Directly sharing the detached FileList is insufficient: clearing the staging input then also clears the provider's shared list. The experiment caught this and passes after cloning through `DataTransfer`. Production code also needs cancellation/reload/error cleanup, turn ownership, remote-object release and a final send-mode check. A delayed or stale commit must never target another chat's input.

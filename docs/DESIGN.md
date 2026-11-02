# QChat design

The owner's brief, which outranks everything below: "compact, bubble-like, modern glassy feel, customizable. There shouldn't be a background. This is the main point of this app, to feel nice to use over the normal website." Recent chats are "tiny little tabs popping out of the chat bar".

QChat is a resident desktop object, used in a glance over whatever else is on screen. It must read as a small physical thing floating on the desktop: one bar, one or two bubbles, nothing else.

## Material: clear glass

One material everywhere. No neon, no marble, no competing highlights.

- **Fill:** one vertical gradient between the look's two tints. The tints are low-chroma; colour belongs to the accent, not the glass.
- **Rim:** a 1px hairline. Dark looks: `rgb(255 255 255 / .13)`. Light looks: `rgb(15 23 42 / .13)`. Inside it, one top specular line (`inset 0 1px 0`): dark `rgb(255 255 255 / .16)`, light `rgb(255 255 255 / .8)`.
- **Shadow:** offset and soft, never a halo. `0 10px 26px -8px rgb(0 0 0 / .42), 0 1px 2px rgb(0 0 0 / .22)`. Light looks use `rgb(15 23 42)` at about half that alpha.
- **Backdrop:** a native companion window really blurs the desktop behind each glass surface when `nativeBlur` is on, and it stays up and aligned while the window moves. The blur setting crossfades that fixed-radius system blur with the sharp desktop. There is no inner scrim layer.
- **Opacity:** the glass setting is literal for the bar, tabs and chips. Message bubbles have their own opacity; with "Keep text readable" on, they never drop below 4.5:1 on any wallpaper. Without native blur, that guard also lifts the glass.
- **Accent** appears only on: the send button, the focus ring, links, list markers, and the selected item in a menu.

## Geometry

| Token | compact | cozy (default) | roomy |
|---|---|---|---|
| bar height | 38 | 44 | 50 |
| control size | 26 | 30 | 34 |

- Bar padding equals `(bar height - control) / 2`, so controls sit concentrically inside the pill.
- The default bar is 460px wide with fully round ends. Replies read in a wider column (640px default), centred over the bar; chips, tabs and the user's bubble line up with the bar.
- Radii: bubble 20, menu 16, chip 12, tab 9.
- Stack gap between objects: 8px.

## Parts

- **Orb:** an 18px brand mark, soft gradient, no specular hotspot. Connection state is a 2px ring on the orb: none when ready, amber for guest/connecting, red for errors. While folded it also carries the reply's state, which replaces the connection ring: a thin spinning arc while waiting (a static ring with motion off), then a green orb with a white "1" on a green badge at the circle's top right when the reply is ready, or the critical colour with "!" when something needs the user. Opening clears it. Green appears nowhere else.
- **Picker:** a small pill in the bar (provider mark, current value, chevron) opens one 244px glass popover above the bar, right-aligned to the pill, which never moves the stack. Like the Latest chip and the reply tools, it is near-solid (at least .94), because the reply under it is outside the native blur. Provider and mode are segmented controls with no headings, then effort and model rows. Accent marks only the selected row.
- **Send:** hidden (opacity 0, scale .8, still in layout, so nothing reflows) until there is something to send, then springs in. Stop replaces it during a reply.
- **Tabs:** sit flush on the bar's top edge: rounded top corners, no bottom rim or shadow, with 8px between tabs. 38px tall, with a semibold 12px title above a quiet 10px provider mark and elapsed time. Titles cap at 24 characters; fewer tabs appear on narrow bars so titles remain readable, with the rest available in All chats.
- **Bubbles:** the user's bubble is the only tinted one, and only lightly. Replies are plain glass.
- **History pill and Latest chip:** small quiet glass chips that never cover reply text.
- **History:** the whole conversation from the account's own record (the rendered page is the fallback), in the same bubbles as the live view, with its images. That record replaces the local copy when a chat opens. A long History opens with its newest messages and fills in older ones above within a moment, without moving what is on screen; Find and a restored reading place get every message at once. "All chats" lists this PC's chats, then every other chat on the account, searchable. A small clock tab beside the recent tabs opens it.
- **Errors:** plain glass with a 1px critical-coloured hairline and critical-coloured title. No muddy red fill.

## Type

Segoe UI Variable. Body 15/1.65 in replies, measure capped at 72ch; the bar uses the same size at 1.45. Secondary text `--text-2` at .86 alpha, tertiary `--text-3` at .72. Reply headings keep a clear hierarchy without rules or extra colour: h1 1.45em, h2 1.25em, h3 1.08em semibold. Inline code is the text colour on a quiet fill; accent stays on links and list markers. Code is Cascadia. Numerals in timestamps are tabular. Table columns keep their Markdown alignment, so figures line up on the right. Task lists show a checkbox in the bullet's place, and keyboard keys are small keycaps.

## Motion

Pressing and hovering are colour only: transforms promote and demote compositor layers as they start and stop, which reads as the whole window jittering. Two authored moments. A sent message rises out of the bar and becomes a bubble, and the reply grows in its place. And when the window has been out of focus for a few seconds (5 by default, Window → "Fold into the orb when idle", 0 turns it off), everything above the bar sinks into it and the bar closes into its orb; a click on the orb, a key, or anything that focuses the window opens it in reverse (the reply and the bar's contents follow the bar as soon as it looks open, so it never sits empty), and dragging the folded orb moves it without opening. It never folds by itself while the words of an ordinary reply are arriving, the pointer is over it, Settings is open or hide-on-blur is on. Any reply may fold while it is only being waited for, with the orb's arc showing the wait, and long Work tasks may fold at any point while running. Clicking the open orb, or the minimize button shown during a reply, folds it at once. Folded parts keep their layout, so the window does not resize and the reply keeps its height. Everything else is quiet: 120 to 200ms, exponential ease-out, transform and opacity. Popovers and chips that open over the stack (picker, command menu, All chats, Latest chip, find and rename bars, the thinking chip, Settings pages) rise a few pixels as they fade in. A closing popover hides at once and an inert, click-through copy fades out in its place, so focus and state never wait on an animation. Notices (errors, the guest notice, confirmations and command feedback) leave the same way, their copy pinned where they stood while the stack settles at once. A copy confirmation settles its glyph in from a little smaller. The default feel is calm, with no overshoot. Reduced motion is respected. No sheen passes over text by default. Scrolling is native: nothing moves, scales or fades messages as they scroll.

The window keeps a fixed reserved size and its empty part is click-through. Never resize it as things open and close: the webview follows a frame behind, and everything jumps.

### Streaming

Text must read as a steady flow, never as a machine catching up.

- By default a block appears only once it is finished (a paragraph at its blank line; list items, table rows and code lines at their newline), then flows in by whole words. Live tokens can be rough until then. Live word and character streams remain as settings.
- Nothing starts on one line and jumps to the next. Network bursts change the rate gradually.
- New words surface from low contrast through the CSS Highlight API: paint only, so no DOM, layout or selection changes.
- Unfinished Markdown is closed or held back, so markers, half tables and raw TeX never flash. Finished blocks are parsed once and left alone.
- Following the end is the reader's choice. One wheel notch up stops it at once and new text never pulls them back; reaching the end resumes it.

## Settings window

A calm utility window, not a showcase. One sheet, flat grouped rows inside, no nested glass. The live bar on the desktop is the preview, so there is no fake-wallpaper preview box. No control has focus styling when the window opens.

- **Layout:** a sidebar of pages under three headings (Basics, Look & feel, Account), one page at a time. Each page opens with a one-line description, then titled groups of rows separated by hairlines. The whole layout is declared once in `PAGES` in `ui/settings.js`, and every setting appears exactly once.
- **Words:** labels say what the user sees ("Blur behind the bar", not "nativeBlur"); hints say what changes. Every choice has a written label.
- **Depth:** frequent controls are visible; fine-tuning sliders sit behind a "Fine-tune" disclosure. A custom colour picker appears only once Custom is chosen. A control that waits on another switch is dimmed, not hidden.
- **Orientation:** a dot in the sidebar marks pages that differ from the defaults, with a "Reset page" button beside the page title. Search (Ctrl+F) spans every page; picking a page clears it.

## Bans

Gradient text. Neon or multi-colour rims. Inner scrims. Glossy marble highlights. Coloured side stripes on callouts. Nested cards. Zero-offset glows. Decorative loops that aren't tied to live state.

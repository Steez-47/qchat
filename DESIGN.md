# QChat design

The owner's brief, which outranks everything below: "compact, bubble-like, modern glassy feel, customizable. There shouldn't be a background. This is the main point of this app, to feel nice to use over the normal website." Recent chats are "tiny little tabs popping out of the chat bar".

QChat is a resident desktop object, used in a glance over whatever else is on screen. It must read as a small physical thing floating on the desktop: one bar, one or two bubbles, nothing else.

## Material: clear glass

One material everywhere. No neon, no marble, no competing highlights.

- **Fill:** one vertical gradient between the look's two tints. The tints are low-chroma; colour belongs to the accent, not the glass.
- **Rim:** a 1px hairline. Dark looks: `rgb(255 255 255 / .13)`. Light looks: `rgb(15 23 42 / .13)`. Inside it, one top specular line (`inset 0 1px 0`): dark `rgb(255 255 255 / .16)`, light `rgb(255 255 255 / .8)`.
- **Shadow:** offset and soft, never a halo. `0 10px 26px -8px rgb(0 0 0 / .42), 0 1px 2px rgb(0 0 0 / .22)`. Light looks use `rgb(15 23 42)` at about half that alpha.
- **Backdrop:** a native companion window really blurs the desktop behind each surface when `nativeBlur` is on. With it, fills may be clearer. Without it (`html[data-nativeblur="off"]`), fills rise until text holds 4.5:1 on any wallpaper. There is no inner scrim layer.
- **Accent** appears only on: the send button, the focus ring, links, list markers, and the selected item in a menu.

## Geometry

| Token | compact | cozy (default) | roomy |
|---|---|---|---|
| bar height | 38 | 44 | 50 |
| control size | 26 | 30 | 34 |

- Bar padding equals `(bar height - control) / 2`, so controls sit concentrically inside the pill.
- The default bar is 460px wide with fully round ends.
- Radii: bubble 20, menu 16, chip 12, tab 9.
- Stack gap between objects: 8px.

## Parts

- **Orb:** an 18px brand mark, soft gradient, no specular hotspot. Connection state is a 2px ring on the orb: none when ready, amber for guest/connecting, red for errors.
- **Send:** hidden (opacity 0, scale .8, still in layout, so nothing reflows) until there is something to send, then springs in. Stop replaces it during a reply.
- **Tabs:** sit flush on the bar's top edge and read as one shape with it: rounded top corners, no bottom rim, no shadow, concave 8px fillets where they meet the bar. 24px tall, 11.5px text, the clock glyph quiet at 10px. Title capped at 24 characters then the elapsed time.
- **Bubbles:** the user's bubble is the only tinted one, and only lightly. Replies are plain glass.
- **History pill and Latest chip:** small quiet glass chips that never cover reply text.
- **Errors:** plain glass with a 1px critical-coloured hairline and critical-coloured title. No muddy red fill.

## Type

Segoe UI Variable. Body 14.5/1.6 in replies, 14/1.45 in the bar. Secondary text `--text-2` at .86 alpha, tertiary `--text-3` at .72. Reply headings keep a clear hierarchy but fit the width: h1 1.4em, h2 1.22em, h3 1.05em semibold. Code is Cascadia. Numerals in timestamps are tabular.

## Motion

One authored moment: a sent message rises out of the bar and becomes a bubble, and the reply grows in its place. Everything else is quiet: 120 to 200ms, exponential ease-out, transform and opacity. Reduced motion is respected. No sheen passes over text by default.

## Settings window

A calm utility window, not a showcase. One sheet, flat grouped rows inside, no nested glass. The live bar on the desktop is the preview, so there is no fake-wallpaper preview box. Frequent controls are visible; fine-tuning sliders sit behind a "Fine-tune" disclosure. No control has focus styling when the window opens.

## Bans

Gradient text. Neon or multi-colour rims. Inner scrims. Glossy marble highlights. Coloured side stripes on callouts. Nested cards. Zero-offset glows. Decorative loops that aren't tied to live state.

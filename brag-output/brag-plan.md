# /brag plan — Jellyfin PDF reader for flight schools

**What it is:** Jellyfin, the free self-hosted media server, now has a real PDF reader. A flight school can host its aeronautical training manuals on its own local server, and teachers and students can read them from any device on the network.

**Focus:** Only the PDF reader (`src/plugins/pdfPlayer`). No video streaming.

**Angle:** The school's manual shelf, on its own server. Open a big manual, jump to any page, zoom into a schematic, and pick a reading mode.

**Hook:** The library fills with manual covers one by one under the line "Every training manual. One shelf."

**Highlights (shown with the real reader UI):**
1. Page slider: drag from page 1 to page 142, with the live "142 / 248" label (the `PdfPageSlider` component).
2. Zoom: zoom_in clicked three times, 100% → 195%, focused on a hydraulic schematic (the `PdfToolbar` zoom buttons and % label).
3. View modes: single → spread → continuous (the three view-mode buttons, with the active one in the primary colour).

**Punchline:** "On your school's own server." Teachers add manuals and students read them on laptops, tablets and classroom TVs. Then the logo and "Your manuals, on your network."

**Tone:** default/polished: clean, calm and confident, with soft dips between scenes.

**Visual identity:** Jellyfin dark palette (`#101010` background, `#202020` paper, `#00a4dc` primary), the logo gradient (`#aa5cc3` → `#00a4dc`), the reader background `#525659`, the Material Icons font the reader uses, and the official banner and icon from `@jellyfin/ux-web`.

**Fictional stand-ins:** The manual titles, page contents, page counts and schematics are illustrative placeholders, not real publications. There are no real names, hosts or user data.

**Music:** 120 BPM (one beat = 0.5 s = 15 frames), in A minor/C major. A soft four-on-the-floor beat, plucked bass, a pad and a bell motif. Every cut lands on a beat.

## Storyboard (21 s, 30 fps)
| # | Time | Beats | Scene |
|---|---|---|---|
| 1 | 0.0–3.0 | 6 | Hook: the headline settles and six manual covers pop into a Jellyfin library grid |
| 2 | 3.0–5.0 | 4 | Reveal: the Jellyfin banner and "Now with a built-in PDF reader." |
| 3 | 5.0–9.0 | 8 | A cursor clicks "Aircraft Systems", the reader opens, and the slider drags to p.142. Caption: "Jump to any page." |
| 4 | 9.0–12.0 | 6 | zoom_in ×3 on beats, the % label counts up. Caption: "Zoom into every schematic." |
| 5 | 12.0–14.5 | 5 | Spread, then continuous. Caption: "Single · Spread · Continuous" |
| 6 | 14.5–18.0 | 7 | A server diagram: Teachers → server → student devices. Headline: "On your school's own server." |
| 7 | 18.0–21.0 | 6 | Outro: the banner and "Your manuals, on your network." |

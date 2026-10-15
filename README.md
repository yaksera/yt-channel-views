# YT Channel Views — Chrome extension

TubeBuddy-style YouTube tools that run on the free YouTube Data API.

## Features

### On YouTube pages
- **Video insights panel** (next to every video): views, views/day, how the video compares with the channel's average (e.g. `3.2×`), like and comment rates, engagement, publish time, length and category, plus the video's **hidden tags** (copy them in one click, or click one to explore it as a keyword) and an **SEO score** checklist.
- **Thumbnail badges** on search results, the home feed and the sidebar: views/day and an **outlier score** (views ÷ the channel's average views per video). Green means 2× or more.
- **Right-click** a YouTube link → *Analyze channel views*. Select any text → *Explore keyword*.

### Channel dashboard (click the extension icon)
- **Total views of long videos, Shorts and live streams** (separately), with upload count, average, median and share of views
- **Recent uploads** — Last 7 / 30 / 90 days, this month or previous month: views per type, % vs all-time average, a views-per-upload chart and a table
- **Best time to publish** — heatmap of median views by weekday × time of day, the top 3 time slots and a per-weekday chart
- **All videos** — filter, sort and export to CSV

### Keyword explorer (Keywords tab)
- Overall, **search demand**, **competition** and exact-match scores for a keyword
- YouTube search suggestions and **A–Z long-tail ideas**
- Tags most used by the top-ranking videos (copy them in one click)
- The top 25 ranking videos with views, views/day, channel size and age

### Top videos by keyword (Top videos tab)
- The **100 / 200 / 300 most viewed long videos and Shorts** for any keyword, in separate lists
- Filter by publish date (any time, last 12 / 6 months, last 30 days) and region (worldwide, India, Nepal, US, UK and more)
- Sort by views, views/day or newest; export both lists to CSV
- Shorts are detected exactly (YouTube serves `/shorts/ID` only for real Shorts), not guessed from the length

All toggles are under **Settings** in the dashboard.

## Setup (one time)

### 1. Get a free YouTube Data API key
1. Open <https://console.cloud.google.com/> and create a project.
2. Go to **APIs & Services → Library**, search **YouTube Data API v3**, click **Enable**.
3. Go to **APIs & Services → Credentials → Create credentials → API key**.
   Under *API restrictions*, either don't restrict it or allow **YouTube Data API v3**. Don't add a website restriction.
   (A Gemini / AI Studio key will **not** work. Those keys are locked to Gemini.)

### 2. Load the extension
1. Open `chrome://extensions` (works in Edge and Brave too) and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Pin the extension and click its icon. Paste your API key under **Settings** and click **Save key**.

After you pull new code, click **↻** on the extension card and refresh any open YouTube tabs.

## Quota (10,000 free units per day)

| Action | Cost |
|---|---|
| Video insights panel | 2 units per video |
| Thumbnail badges | ~2 units per 50 thumbnails |
| Channel dashboard | ~1 unit per 25 uploads (about 40 for a 1,000-video channel) |
| Keyword explorer | ~102 units per keyword (YouTube search costs 100). A–Z ideas are free. |
| Top videos by keyword | ~101 units per 50 results: about 600–2,000 units for 300 long + 300 Shorts |

## Notes
- All numbers are public data at the time you fetch them. The public API doesn't give per-day view history or real search volume, so the keyword scores and best-time analysis are estimates built from the top results and past uploads.
- The SEO score is a simple checklist: title length, main tag in the title and description, description length, tag count and tag-box usage, hashtags, chapters, HD thumbnail, captions and HD video.
- Features that change your own channel (A/B thumbnail tests, bulk edits) need Google sign-in and app verification, so they aren't included.

## Making a zip for clients

```bash
python build_zip.py
```

This creates `dist/yt-channel-views-v<version>.zip` (the version comes from `manifest.json`). Clients follow `INSTALL.txt` inside the zip.

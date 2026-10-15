# YT Channel Views — Chrome extension

Click the extension icon on any YouTube channel, video or Short and it opens a dashboard with:

- **Total views of Long videos, Shorts and Live streams** (separately), with upload count, average, median and share of views
- **Recent uploads analytics** — Last 7 / 30 / 90 days, this month or previous month: views per type, uploads, avg views, % vs the channel's all-time average, a views-per-upload chart, and a table with views/day, likes and comments
- **All videos** list — filter by type, sort by views or date, export to CSV

You can also paste any channel link, video link, `@handle` or channel ID into the search box, or right-click a YouTube link → **Analyze channel views**.

## Setup (one time, ~3 minutes)

### 1. Get a free YouTube Data API key
1. Open <https://console.cloud.google.com/> and create a project (any name).
2. Go to **APIs & Services → Library**, search **YouTube Data API v3**, click **Enable**.
3. Go to **APIs & Services → Credentials → Create credentials → API key**. Copy the key.
   (Optional: under *API restrictions* restrict it to YouTube Data API v3. Don't add a website restriction.)

### 2. Load the extension
1. Open `chrome://extensions` (works in Edge/Brave too).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (`D:\yt-channel-views`).
4. Pin the extension, open any YouTube channel/video, click the icon.
5. First time only: paste your API key in the panel and click **Save key**.

## How it works

YouTube keeps hidden per-channel playlists for each upload type — `UULF…` (long videos), `UUSH…` (Shorts) and `UULV…` (live streams). The extension lists each one, then fetches exact view counts 50 videos at a time.

**Quota:** the free daily quota is 10,000 units. A channel with 1,000 uploads costs about 40 units, so you can analyze hundreds of channels a day.

## Notes

- View counts are exact public counts at the time you fetch. "Recent uploads" means videos *published* in that window and their total views so far (the public API doesn't give per-day views for channels you don't own).
- The per-video sum can differ slightly from the channel's YouTube total, since that total also includes deleted, private and members-only videos.
- Upcoming (scheduled) streams show 0 views.

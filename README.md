# Instaloader

A lightweight Chrome extension for downloading images and direct video files from websites.

Built as a fast, minimal, no-nonsense media grabber for static assets found on regular web pages.

Only supports direct media files made accessible by the website.

## Features

- Detects and downloads:
  - Images
  - Direct video files
  - Background-image assets
  - High-resolution srcset images
- Bulk download visible images as ZIP
- One-click individual downloads
- Right-click media cards to copy URLs
- Filters for:
  - Images/videos
  - Large/medium images
- Lightweight popup UI
- No tracking
- No analytics
- No account required

## Limitations

Instaloader works with **direct media files**.

It does **not** support adaptive streaming technologies such as:

- MediaSource
- HLS
- DASH

This means platforms like YouTube, Twitch, Netflix, and many modern video sites cannot be downloaded through the extension.

For those cases, tools like [yt-dlp](https://github.com/yt-dlp/yt-dlp) or a screen recorder are recommended instead.

## Privacy

Instaloader does not collect, store, or transmit user data.

The extension only requests the permissions necessary to detect and download media from the currently open tab.

## Installation (Developer Mode)

1. Download or clone this repository
2. Open Chrome and go to:
   ```
   chrome://extensions
   ```
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the project folder

## Chrome Web Store

Coming soon.

## Tech Notes

This project was built with the help of modern AI-assisted development tools including:

- ChatGPT Codex
- Cursor
- Claude Code

## Contributing

Bug reports, suggestions, and pull requests are welcome.

## Support

If this extension helped you out and you'd like to support future updates:

- Ko-fi: [ClopesCode](https://ko-fi.com/clopescode97)

## License

MIT

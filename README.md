# LLM Prompt Queue

A Chrome extension that lets you queue multiple prompts and automatically sends them to AI chat interfaces one after another.

Stop waiting around — write all your prompts upfront, and let the extension handle the rest.

## Supported Platforms

- ChatGPT (chat.openai.com, chatgpt.com)
- Claude (claude.ai)  
- Google Gemini (gemini.google.com)
- Google AI Studio (aistudio.google.com)

## Features

- **Queue Management** — Add, reorder, and remove prompts easily
- **Auto-Send** — Automatically sends the next prompt when AI finishes responding
- **Persistent Storage** — Queue saves across browser sessions
- **Status Indicator** — Always know what's happening
- **Dark/Light Mode** — Matches your system preferences
- **100% Local** — No cloud, no accounts, no data collection

## Installation

### From Chrome Web Store
[Link to Chrome Web Store] *(coming soon)*

### Manual Installation (Developer Mode)
1. Clone this repository
```bash
   git clone https://github.com/yourusername/llm-prompt-queue.git
```
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the cloned folder

## Usage

1. Open any supported AI chat site
2. Click the extension icon in your toolbar
3. Type a prompt and click **Add to Queue**
4. Repeat to add more prompts
5. Toggle **Auto-send** on
6. Send your first prompt (or let it auto-start)
7. Sit back — the extension sends each queued prompt automatically

## How It Works

The extension monitors the AI chat interface for response completion by detecting UI state changes (send button enabled, stop button gone). When a response finishes, it:

1. Takes the next prompt from the queue
2. Injects it into the chat input field
3. Clicks the send button
4. Repeats until the queue is empty

## Privacy

- All data stored locally via `chrome.storage.local`
- Zero network requests to external servers
- No analytics, tracking, or telemetry
- No account required

## Tech Stack

- Manifest V3
- Vanilla JavaScript (no frameworks)
- Chrome Extensions API

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)

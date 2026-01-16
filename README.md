# Daily Commit Summarizer (Local Version)

A local CLI tool to generate daily commit summaries using AI and send them to Feishu/Lark. Adapted from [daily-commit-summarizer](https://github.com/nanbingxyz/daily-commit-summarizer).

## Setup

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Configuration**:
    Copy `.env.example` to `.env` and fill in your API keys:
    ```bash
    cp .env.example .env
    ```
    - `OPENAI_API_KEY`: Your OpenAI API key.
    - `LARK_WEBHOOK_URL`: Your Feishu group bot Webhook URL.

## Usage

Run the tool from this directory:

```bash
# Analyze the current directory (default)
npm start

# Analyze a specific repository
npm start -- --repo /path/to/your/repo

# Analyze commits from the last N days (default 1)
npm start -- --days 3
```

## Features

-   **Local Execution**: Runs entirely on your machine.
-   **Any Repo**: Can analyze any local git repository.
-   **Smart Scanning**: Checks for remote branches first, falls back to local branches if offline or no remote.
-   **AI Summaries**: Uses OpenAI (or compatible) API to summarize diffs.
-   **Notifications**: Sends a formatted report to Feishu/Lark.

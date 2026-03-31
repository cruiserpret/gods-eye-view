# God's Eye View (Local)

A local version of your Instagram "swarm intelligence" app.

## What this does
- Upload a photo
- Add a song, caption, and optional context
- Simulate 4 agent personas
- Get a final "God's Eye View" summary

## Requirements
- Node.js 18+
- An Anthropic API key

## Setup

```bash
npm install
cp .env.example .env
```

Open `.env` and paste your Anthropic API key.

## Run

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

## Notes
- The frontend compresses the uploaded image before sending it.
- The backend calls Anthropic securely so your API key does not live in browser code.
- Default model is `claude-sonnet-4-6`. You can change it in `.env`.

## Common problems

### "Missing ANTHROPIC_API_KEY"
Your `.env` file is missing or the key name is wrong.

### Timeout / slow response
Try again, or switch to a faster model in `.env`, for example:

```text
MODEL=claude-haiku-4-5
```

### Port already in use
Change:

```text
PORT=3001
```

in `.env`, then restart.

## Project structure

```text
gods-eye-view-local/
  public/
    index.html
    styles.css
    app.js
  .env.example
  .gitignore
  package.json
  README.md
  server.js
```

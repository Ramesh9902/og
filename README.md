# Media Link Downloader

This project uses:

- Frontend: `HTML`, `CSS`, `JavaScript`
- Backend: `Node.js` + `Express`
- Database: `MySQL`
- Downloader engine: `yt-dlp`

It does not use `PHP`, `XAMPP`, `DELIMITER`, or stored procedures.

## Supported links

- YouTube
- Twitter / X
- Instagram

Use only media that you own or have permission to download.

## Files

- `server.js`: backend API and static server
- `db.js`: MySQL connection pool
- `services/downloadService.js`: download logic with `yt-dlp`
- `public/index.html`: frontend page
- `public/styles.css`: frontend styles
- `public/app.js`: frontend logic
- `sql/schema.sql`: MySQL Workbench schema
- `.env.example`: environment variables sample

## Setup

1. Install `Node.js`
2. Install `MySQL Server`
3. Install `yt-dlp`
4. Optional but recommended: install `ffmpeg`
5. Open MySQL Workbench and run `sql/schema.sql`
6. Copy `.env.example` to `.env`
7. Update the MySQL username and password in `.env`
8. Run:

```bash
npm install
npm start
```

## yt-dlp install

If Python is already installed:

```bash
pip install -U yt-dlp
```

If you use a standalone `yt-dlp.exe`, place it in your system `PATH` or set `YTDLP_PATH` in `.env`.

## Run

After starting the project, open:

`http://localhost:4000`

Main pages:

- `/login.html`
- `/register.html`
- `/dashboard.html`

The root `/` now redirects to the login page.

## Authentication

- New users can register with `name`, `email`, `password`, and `confirm password`
- Login requires a valid `email` and `password`
- Password rules:
  - minimum `8` characters
  - at least `1` uppercase letter
  - at least `1` lowercase letter
  - at least `1` number
  - no spaces
- Download history is now scoped per logged-in user

## Notes

- Private or login-protected posts may fail.
- Some platforms may change their site rules or formats, so `yt-dlp` should be kept updated.
- Downloading content may be restricted by copyright law or site terms. Check the rules before using it.

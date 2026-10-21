# Crew Jobs

A small job and invoice tracker for service businesses, like a plumbing or lawn care crew. It's the practice app for the Zenoflo Engineering Academy.

**Every name, email, address and amount in Crew Jobs is made up.** Never put real customer data in it.

> **Practising pull requests?** Open them on **your own fork**, not here. On a fork, GitHub picks this original repository as the base by default: change the base repository to `YOUR-NAME/crew-jobs` before you click **Create pull request**. Practice pull requests opened here get closed with a pointer to Chapter 12, Lesson 3.

## Run it locally

You need **Node.js 22 or newer** and **Git**. Nothing else: no database to install, no accounts, no `.env` file.

1. Check your Node.js version. The first number must be 22 or higher:

   ```
   node --version
   ```

2. Install the dependencies (run this inside the `crew-jobs` folder):

   ```
   npm install
   ```

3. Start the app:

   ```
   npm start
   ```

   The first start takes a few seconds while it creates the local database and fills it with made-up data. Then you'll see:

   ```
   Crew Jobs is running at http://localhost:3000 (LOCAL)
   ```

4. Open `http://localhost:3000` in your browser. The header says **LOCAL**.

5. To stop it, press **Ctrl + C** in the terminal window where it's running (on Mac too).

The local database lives in the `data` folder. Git ignores it. To start again from fresh made-up data, stop the app, delete the `data` folder and run `npm start`.

## Test accounts

All made up, for local use only. The password for every account is `test-password`.

| Business | Role | Email |
|---|---|---|
| Bright Plumbing | Owner | `owner@brightplumbing.example` |
| Bright Plumbing | Staff | `staff@brightplumbing.example` |
| Green Lawn Care | Owner | `owner@greenlawn.example` |
| Green Lawn Care | Staff | `staff@greenlawn.example` |

Owners see jobs, invoices, the CSV export and their staff. Staff see jobs only, never invoices. Neither business can see the other's data.

## What's inside

| Folder | What it holds |
|---|---|
| `src/` | The server: Express routes (`routes.ts` is the single list of every route), sign-in, the database connection and checks on every input |
| `public/` | The web page: plain HTML, CSS and JavaScript |
| `migrations/` | Numbered SQL files that build the 5 tables, applied in order on start |
| `tests/` | Tests for every route, including the refused cases |
| `scripts/` | The size budget check |

Useful commands:

| Command | What it does |
|---|---|
| `npm start` | Runs the app |
| `npm test` | Runs every test |
| `npm run check` | Typecheck, tests and the size budget, the same as CI |

## Rules this app keeps

- Each business only ever sees its own data. The server takes the business from your session, never from the request.
- Staff can't see invoices or invoice amounts anywhere.
- Every input is checked on the server, whatever the page already checked.
- Passwords are stored only as scrypt hashes, and sessions only as hashes of their tokens.
- Every secret comes from an environment variable. `.env.example` lists the names. Local use needs none of them.
- The app stays small enough to read: 5 tables, 15 routes and 2,000 lines of app code at most. CI fails if it grows past that.

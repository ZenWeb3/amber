markdown# amber

a slack agent that learns to route questions across multiple mcp tools.

most slack agents wire up one tool and hardcode when to call it. amber treats tool selection as a learned routing problem — every reaction on her answers updates her routing priors, so she gets sharper the more your team uses her.

built for the [slack agent builder challenge](https://slack-agent-builder.devpost.com) — jul 2026.

## what it does

ask amber a question in slack. she figures out which of her connected tools (github, google drive, calendar, notion, web search) is the right one to answer, runs the query, and posts the answer back as a threaded reply.
you:    /ask what prs are blocking the launch?

amber:  pulling open prs from your-org/main-repo...

3 prs are currently blocked:

• #142 — auth refactor (waiting on review from @kemi)

• #138 — payment provider switch (failing ci)

• #131 — migration script (merge conflict)

routed via: github (confidence 0.91)

react with 👍 or 👎 and amber updates her routing priors. over time she learns which tools win for which kinds of questions.

## architecture

five components in the request pipeline plus a feedback loop:

| component   | what it does                                                  |
|-------------|---------------------------------------------------------------|
| classifier  | extracts features from the incoming query                     |
| router      | consults learned priors to predict the best tool              |
| planner     | generates a structured plan, sometimes multi-step             |
| executor    | calls one or more mcp servers and collects results            |
| synthesizer | writes a clean answer back to slack                           |
| evaluator   | scores outcomes from 👍/👎 reactions, updates the router      |

the router's learned state lives in supabase. cold-start uses heuristic priors; the table updates after every query.

## tools amber speaks

amber connects to these mcp servers:

- **github** — repos, prs, issues, commits, workflows (official mcp server)
- **google drive** — search and read docs
- **google calendar** — events and availability
- **notion** — pages and databases
- **real-time search** — the web, for fresh context

new tools register as config — the routing logic doesn't change.

## stack

- **typescript** + **slack bolt** for the slack app
- **google gemini** (2.5 flash) as the brain
- **model context protocol** for tool integration
- **supabase** (postgres) for router state and query logs

## setup

```bash
# 1. clone and install
git clone https://github.com/your-username/amber-slack.git
cd amber-slack
pnpm install

# 2. download the github mcp server binary
mkdir -p bin
curl -L $(curl -s https://api.github.com/repos/github/github-mcp-server/releases/latest \
  | grep "browser_download_url.*Linux_x86_64.tar.gz" \
  | cut -d '"' -f 4) | tar -xz -C bin

# 3. configure your .env
cp .env.example .env
# fill in: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET,
#         GEMINI_API_KEY, GITHUB_TOKEN, and supabase keys

# 4. run
pnpm run dev
```

then in slack, dm amber a question or use `/ask` in any channel she's been invited to.

## environment variables

| name                     | what                                       |
|--------------------------|--------------------------------------------|
| `SLACK_BOT_TOKEN`        | xoxb- bot token from your slack app        |
| `SLACK_APP_TOKEN`        | xapp- app-level token (socket mode)        |
| `SLACK_SIGNING_SECRET`   | slack app signing secret                   |
| `GEMINI_API_KEY`         | google ai studio api key                   |
| `GITHUB_TOKEN`           | github personal access token (repo scope)  |
| `SUPABASE_URL`           | supabase project url                       |
| `SUPABASE_ANON_KEY`      | supabase anon key                          |

## why "amber"

amber is what light becomes when it slows down enough to think. felt right for an agent that learns instead of just reacts.

## status

active development for the slack agent builder challenge.

## license

mit
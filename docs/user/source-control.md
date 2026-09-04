# Source Control Integrations

T3 Code connects to your Git hosting provider so you can create pull requests, review code, and manage repositories without leaving the app.

## Supported Providers

T3 Code works with the platforms your team already uses:

- **GitHub** – Pull requests, repository creation, and clone integration
- **GitLab** – Merge requests, repository publishing, and hosted clones
- **Bitbucket** – Pull request workflows (via API token authentication)
- **Azure DevOps** – Pull request support for Microsoft-hosted repositories

## What You Can Do

### Start Projects from Anywhere

**Clone repositories directly**

- Open the Command Palette (`Cmd/Ctrl + K`) → **Add Project**
- Choose **GitHub repository**, **GitLab repository**, **Bitbucket repository**, **Azure DevOps repository**, or paste any **Git URL**
- Enter the repository path (`owner/repo`, `group/project`, `workspace/repository`, or `project/repository`) or a full Git URL, pick a destination, and start coding

**Forks come wired up**

- Cloning a GitHub fork also adds the repository it was forked from as an `upstream` remote, so you can fetch from the original project right away
- Because two remotes means two possible targets, cloning a fork adds one step: choose which repository is the **default repository**. Your fork is offered first; choose the original project instead when you are cloning to contribute upstream.
- The default repository is where pull requests, issues, and releases go — including the ones T3 Code creates and the **Pull requests** page it lists.
- Branches keep their own alignment: once a branch tracks a remote, that repository is the one T3 Code treats it as belonging to, so a branch pushed to the original project groups with the original project and a branch on your fork stays with your fork.
- Change your mind later on web or desktop in **Settings → Projects → Checkout → Default repository**. It is the same setting as the GitHub CLI's `gh repo set-default`, so the two agree in both directions.
- Fork detection is GitHub-only. Clones from GitLab, Bitbucket, Azure DevOps, or a plain Git URL are untouched.

**Publish local projects to the cloud**

- Have a local Git repository without a remote?
- Use the **Publish Repository** action to create a new hosted repository (GitHub, GitLab, Bitbucket, or Azure DevOps), add it as your origin remote, and push, in one flow
- If the local repository has no commits yet, publishing creates the remote and wires it up but does not push. Make a commit, then push normally.

**Repositories with no commits**

- A repository you have just initialized has a branch name but no commits behind it, so there is nothing for a new worktree to branch from. Until a first commit exists, new threads run in **Current checkout** even when your default is **New worktree** — the agent can make that first commit itself, and the default takes effect again from then on.
- The Git actions toolbar's commit action does exactly this, and reads **Create first commit** in a project that has no remote yet. It stages everything in the project, suggests a message, and commits — after which worktree threads and the branch actions work as usual.

### Manage Code Reviews Without Context Switching

**Create pull requests while you work**

- Push a branch and create a pull request from the Git actions controls in the toolbar
- T3 Code can suggest titles and descriptions based on your commits
- Supports GitHub Pull Requests, GitLab Merge Requests, Bitbucket Pull Requests, and Azure DevOps Pull Requests

**Stay on top of open reviews**

- See if your current branch already has an open PR/MR
- Open several reviews from the **Pull requests** page as tabs in the right panel
- Use **Checks** to see which GitHub checks are required by repository policy, including checks
  GitHub is still waiting to receive, and whether the pull request is ready to merge or blocked
- When GitHub is waiting on repository requirements and auto-merge is available, **Auto-merge**
  replaces the primary **Merge** action and merges the pull request as soon as it becomes ready
- Read ordinary files expanded by default in **Code changes**; lockfiles and oversized files stay
  folded until opened, while files with review comments remain expanded
- In a thread's local Files viewer, lockfiles and files marked `linguist-generated` by the
  repository stay folded until opened
- View repository-hosted images in GitHub pull request descriptions, including private repositories
- See the whole ladder of a GitHub [stacked pull request](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs)
  in the **Stack** section of its Summary tab — every layer with its state, top of the stack
  first, down to the base branch. Click another layer to open it in T3 Code, or
  command-click (Control-click on Windows and Linux) to open it on GitHub
- While working in a thread, open linked reviews in the same compact right-panel tabs without
  leaving the conversation
- Open the review directly in your browser with one click
- If T3 Code cannot load a GitHub pull request, including when GitHub rate limits requests, use
  **Open on GitHub** in the error view
- Command-click (Control-click on Windows and Linux) a pull request number in the sidebar to open it in your browser instead of in T3 Code
- Check out a teammate's branch to review code locally

**Fix what you wrote, in place**

- Rewrite a pull request's title and description from the review itself, in Markdown, with a
  preview before you save
- Rewrite your own comments the same way, wherever they are shown
- Works on GitHub, GitLab, and Bitbucket. Azure DevOps takes a new title and description; its
  comments stay read-only here, as they already were

![A repository-hosted image rendered inside a GitHub pull request description](./images/pull-request-description-image-after.jpg)

When a GitHub project has multiple remotes, the **Pull requests** page follows the current branch's
tracked remote. If the branch has no tracked remote, it follows the repository selected by
`gh repo set-default`. The current branch's PR indicator verifies both the branch name and its head
repository, so a fork checkout does not pick up a same-named branch from `upstream`.

### Start a Thread from a GitHub Issue

Open the command palette and run **New thread from GitHub issue…** to pick from the current
project's open issues.

- Search the list by issue number or title
- Picking an issue opens a new thread draft with the issue's title, body, and comments attached as
  a removable context chip
- Nothing is sent automatically — write your instructions, then send when you're ready
- If the GitHub CLI isn't installed or signed in, the picker tells you what to fix

Issue browsing is GitHub-only today.

### Know Your Setup at a Glance

The **Source Control settings** page shows you exactly what's connected:

- ✅ Which providers are authenticated and ready
- ⚠️ What's missing and how to fix it
- 👤 Which account is signed in (when available)

Run a quick **Rescan** after setting up a new machine or changing credentials.

## Getting Started

### For GitHub (Recommended for most users)

1. Install the GitHub CLI (version 2.81.0 or newer) on the machine running T3 Code:
   ```bash
   brew install gh
   ```
2. Sign in:
   ```bash
   gh auth login
   ```
3. Open **Settings → Source Control** in T3 Code and verify GitHub shows as authenticated

You can now clone, publish, and create pull requests.

### For GitLab

1. Install the GitLab CLI:
   ```bash
   brew install glab
   ```
2. Authenticate:
   ```bash
   glab auth login
   ```
3. Check **Settings → Source Control** to confirm the connection

### For Bitbucket

Bitbucket uses tokens instead of a CLI tool. Two options, both set as environment variables on the
machine running T3 Code.

Recommended, a Bitbucket access token:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

Or an Atlassian account email plus API token, with read/write access to pull requests and
repositories, plus read access to your user account (`read:user:bitbucket`, used to verify the
connection):

```bash
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

If both are set, the access token wins. Restart T3 Code and verify the connection in **Source
Control settings**.

### For Azure DevOps

1. Install Azure CLI:
   ```bash
   brew install azure-cli
   ```
2. Add the DevOps extension:
   ```bash
   az extension add --name azure-devops
   ```
3. Sign in:
   ```bash
   az login
   ```

---

## Requirements & Troubleshooting

**Git is required** – T3 Code uses Git for all local operations. Ensure `git` is installed on your server.

**Server-side setup** – Authentication happens on the machine running T3 Code (the server), not your local browser. If you're using a hosted or team instance, your administrator may have already configured providers.

**Common issues:**

- **Provider shows "Not authenticated"** – Run the login command for that provider (e.g., `gh auth login`) in a terminal on the server, then rescan in Settings
- **GitHub says it could not verify sign-in status** – T3 Code needs GitHub CLI 2.81.0 or newer to check sign-in status. Update `gh` (e.g., `brew upgrade gh`), then rescan
- **GitHub operations are unexpectedly failing** – **GitHub outage alerts** are enabled by default and can be managed in **Settings → Beta**. When GitHub reports a service disruption, T3 Code shows the affected services above **Settings** in the web and desktop sidebar. Git operations, pull requests, Actions, and deploys are all covered; a Copilot-only disruption stays quiet. Select the notice to open the official GitHub Status page.
- **Bitbucket not connecting** – Double-check your environment variables are set in the correct shell profile and the server was restarted
- **Can't push to a remote** – Verify your Git remote URL matches the provider you've authenticated with (SSH vs HTTPS remotes may need different credentials)

![The sidebar stays quiet while GitHub is healthy and shows affected services during an outage](./images/github-status-before-after.png)

**Need more help?** Check your provider's CLI documentation:

- [GitHub CLI](https://cli.github.com/)
- [GitLab CLI](https://gitlab.com/gitlab-org/cli)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/)

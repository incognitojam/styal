# Source control

T3 Code integrates with GitHub, GitLab, Bitbucket, and Azure DevOps to clone and publish
repositories, create pull requests, and review changes.

## Connect an account

Install Git and configure authentication on the machine running your T3 Code server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source Control**
and choose **Rescan**.

### GitHub

Install [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, then sign in:

```bash
gh auth login
```

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Set an access token in the server's environment:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

Or use an Atlassian account email and API token with read/write access to repositories and pull
requests, plus user read access (`read:user:bitbucket`):

```bash
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

The access token takes precedence if both are configured. Restart the server after changing these
variables.

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

## Clone or publish a project

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it. GitHub repositories clone over HTTPS;
to use SSH, choose **Git URL** and paste the SSH clone URL.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

### Clone a GitHub fork

Cloning a GitHub fork keeps your fork as `origin`, adds the repository it was forked from as
`upstream`, and asks you to choose the **default repository**. Pull requests, issues, and the
**Pull requests** page use the default repository. Choose the original project when you are
cloning to contribute to it.

A branch that tracks a remote belongs to that remote's repository, regardless of the default. To
change the default later, open **Settings → Projects → Checkout → Default repository**. This is the
same setting as `gh repo set-default`, so the two stay in agreement. Clones from other hosts or a
plain Git URL do not get this step.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. T3 Code can generate commit
messages, review titles, and descriptions from your changes.

Choose the writing style and model in **Settings → Source Control**. **Repository conventions**
uses the project's instructions and recent commit subjects.

## Start a thread from a GitHub issue

Run **New thread from GitHub issue…** from the command palette and search the current project's
open issues by number or title. The issue's title, body, and comments are attached to a new thread
draft as removable context. Nothing is sent until you write your instructions and send them.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch,
or merge. You can edit review titles and descriptions and your own comments where the host allows it.
GitLab calls these merge requests.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

For Azure DevOps, use the host website to view diffs or change comments. Bitbucket does not support
reopening a declined pull request.

For GitHub pull requests:

- **Checks** separates checks required by repository policy from optional ones, including required
  checks that have not reported yet. When rules require an out-of-date branch to be updated before
  merging, it explains why and offers the update methods you can use. Auto-merge waits for that
  update; it does not perform it.
- A stacked pull request lists every layer of its stack on the Summary tab. Select a layer to open
  it, or Cmd/Ctrl-click to open it on GitHub.
- Images stored in the repository display in pull request descriptions, including for private
  repositories.
- On web and desktop, pull request links in descriptions and comments open another tab beside the
  same thread when the linked repository is available in that environment. Cmd/Ctrl-click opens the
  link in your browser.
- With several remotes, the **Pull requests** page follows the current branch's tracked remote, or
  the default repository when the branch does not track one.

A pull request's changed files open expanded, except lockfiles and very large files, which stay
folded until you open them. A thread's Files viewer also folds lockfiles and files the repository
marks `linguist-generated`.

**Proactive panels** is on by default: a newly linked review opens automatically, and agent work
that changes files switches to its diff when the turn completes. Turn it off in
**Settings → General**.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  confirm the running server received the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **GitHub operations fail unexpectedly:** when GitHub reports a disruption, web and desktop show
  the affected services in the sidebar while you have a GitHub project. Select the notice to open
  GitHub Status.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

# Security Policy

## Reporting a vulnerability

Please open a GitHub security advisory for vulnerabilities that could expose credentials, saved articles, or authenticated endpoints. Do not include real secrets, private article content, or production data in a public issue.

## Secrets

Readlater never needs credentials committed to the repository. Keep provider keys, session secrets, passwords, Notion tokens, and worker tokens in `.env` or your deployment secret manager.

If a credential is committed even briefly, revoke or rotate it before removing it from Git. Deleting it from the latest commit does not remove it from repository history.

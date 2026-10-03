# Deploy with Sohwe links

A Deploy with Sohwe link opens **New application** on a Sohwe instance with a repository ready to review. Put one in your repository README or internal setup notes when teammates deploy the same app on their own instance. The person opening the link needs an owner or admin account on that instance.

The link is the instance dashboard's `/apps` URL with these query parameters:

| Parameter | Required | Meaning |
| --- | --- | --- |
| `repo` | Yes | HTTPS Git repository URL. For a private GitHub repository, connect and grant access to the repository under **Git** first. |
| `branch` | No | Branch to inspect and track. If omitted, Sohwe loads the remote default branch. |
| `config` | No | Repository-relative `sohwe.yaml` path, such as `apps/api/sohwe.yaml`. If omitted, Sohwe looks for `sohwe.yaml` at the repository root. |

For example, a link to a public repository with its root config file:

```text
https://sohwe.example.com/apps?repo=https%3A%2F%2Fgithub.com%2Facme%2Fweb
```

For a monorepo with a nested config file and a selected branch:

```text
https://sohwe.example.com/apps?repo=https%3A%2F%2Fgithub.com%2Facme%2Fplatform&branch=release%2Fnext&config=apps%2Fapi%2Fsohwe.yaml
```

Replace `sohwe.example.com` with the target instance's dashboard host. URL-encode each parameter value; for example, `new URLSearchParams({ repo: "https://github.com/acme/web", branch: "main" }).toString()` produces the query string. A README can use `[Deploy with Sohwe](https://sohwe.example.com/apps?repo=https%3A%2F%2Fgithub.com%2Facme%2Fweb)`.

Only repository location, branch, and config path belong in the URL. **Never put variable values, tokens, or credentials in a deploy link.** The link does not create or deploy anything by itself. Sohwe inspects the branch, shows the effective build plan, and asks for required variable values declared in [`sohwe.yaml`](./sohwe-yaml.md). The admin can change the suggested settings, choose whether later GitHub pushes deploy, and then choose **Create and deploy** or **Save for later**. Variable values entered in the form are stored encrypted by Sohwe.

An invalid link shows a correction on the Applications page. If the user is signed out, Sohwe returns to the link after sign-in. A member can view applications but needs an owner or admin to create one.

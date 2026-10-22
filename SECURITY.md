# Security policy

MGM holds billing records, payments, and the credentials operators use to reach their metering systems and payment providers. This page explains how to report a vulnerability in MGM and what happens after you do.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability reporting. **Do not open a public issue, pull request, or discussion about a vulnerability.**

1. On this repository's main page, open the security tab (**Security and quality**; if it is not shown, it is in the overflow menu next to the other tabs).
2. Click **Report a vulnerability**, fill in the form, and submit it.

GitHub's guide to the form: [Privately reporting a security vulnerability](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability).

Your report creates a private security advisory. It is visible only to you, to the people who manage this repository's security advisories (repository administrators, and the organization's owners and security managers), and to anyone they invite to help with it. Further discussion happens there.

## What to include

- The MGM release tag you run, or, if you run from a branch, the commit SHA (the version in `package.json` is not enough).
- How MGM was installed (on Vercel, from the container image, or from source) and which Supabase setup it runs on (Supabase Cloud, the Supabase CLI local stack, or self-hosted).
- The affected part: a route, a plugin, a database migration or policy, a container image, or a documentation page.
- What an attacker can do, and what access they need first (none, any signed-in user, an organization manager, and so on).
- Steps to reproduce using synthetic data, and any proof-of-concept code.
- Any fix or mitigation you suggest.
- Whether anyone else knows about the problem, and any disclosure date you have in mind.

Leave out real personal data, customer data, and working credentials. If you found an exposed credential, say where you found it, not what it is.

## Scope

In scope:

- The code in this repository: the application, bundled plugins, database migrations and Row Level Security policies, and scripts.
- Release artifacts built from it, such as source archives and container images.
- Installation, upgrade, and recovery documentation that would leave an installation insecure if followed.

We especially want to hear about anything that breaks one of MGM's guarantees:

- One organization can read or change another organization's data.
- OpenEMS or payment credentials reach the browser or logs, or are stored unencrypted.
- A plugin that is disabled for an organization can still change that organization's data or call an external system on its behalf (reads stay available by design).
- A closed billing period changes, or a period closes without a person closing it.

Out of scope:

- Vulnerabilities in the services and software MGM builds on, such as Supabase, Vercel, OpenEMS, payment providers, and npm packages, unless MGM's use of them makes an installation exploitable. Report those to their maintainers.
- Plugins distributed outside this repository.
- What trusted parties can do by design. Server plugins are trusted application code: the plugin gate controls which plugins can change an organization's data or call external systems for it, not what a plugin's code can do. Super administrators, and anyone holding an installation's Supabase service-role key or database credentials, have full access.
- The configuration of a particular installation. Contact that installation's operator.

Test only against an installation you run yourself, with synthetic data. Do not access, change, or delete data that is not yours.

## Supported versions

| Version | Receives security fixes |
|---|---|
| `main`, until 0.1.0 is published | Yes, as commits on `main` |
| Latest minor release, from 0.1.0 | Yes, as patch releases |
| Earlier minor releases | No routine fixes; upgrade to the latest minor release |

Before 0.1.0, only the `main` branch is supported. From 0.1.0 onward, fixes ship as patch releases of the latest minor release. Earlier releases receive no routine backports; their documentation and upgrade instructions remain available. Prerelease tags, such as release candidates, are not supported.

## What happens after you report

1. **Acknowledgement within 7 days.** We acknowledge every report within 7 days of receiving it.
2. **Assessment.** We may ask questions in the advisory. Once we confirm the vulnerability, we give you a timeline for the fix and tell you in the advisory if it changes. If we decide the report is not a vulnerability or is out of scope, we tell you in the advisory and close it.
3. **Private fix.** We develop and review the fix in the advisory's temporary private fork, where we may invite you to collaborate. GitHub runs no CI there, so a maintainer runs the full test suite and the release build checks on a machine they control, in a disposable environment (a local Supabase stack with synthetic data) that is discarded afterwards, and records privately which commit was tested and the results. Until it merges, the fix is not pushed to any other repository, or built or tested in GitHub Actions or in any other hosted or shared environment.
4. **Preparation.** Before the fix merges, we prepare the patch release and write the advisory, which stays in draft.
5. **Release.** We merge the fix and, because merging makes it public, promptly publish the patch release with its artifacts. We then check that the release is usable: its artifacts, such as the source archive and container image, can be downloaded or pulled without signing in, their checksums and signatures or provenance verify, and the release installs. Before 0.1.0, the release is the merged commit on `main`, and we check that it is public and installs from a clean checkout.
6. **Advisory.** Only after the release passes those checks do we publish the advisory, naming the fixed version (before 0.1.0, the fixing commit on `main`), so it always points to a fix operators can install. If publishing or checking the release fails, the advisory stays in draft while we repair the release and check it again. The merged fix remains public in the meantime, because a merged commit cannot be made private again. GitHub lists you as a credited reporter on the advisory; tell us if you would rather not be credited. We may also request a CVE identifier for it.

During the 0.x series there is no advance notice. No installation is upgraded ahead of the release, including those run by MGM's maintainers, and no other operator is notified before it; every operator upgrades from the published release by following its upgrade instructions.

Please keep the vulnerability confidential until the advisory is published. If you plan to publish your own write-up, tell us in the advisory so we can agree on timing.

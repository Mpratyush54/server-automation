# Security policy

## Reporting a vulnerability

Please report security problems privately, not in public issues, pull requests or discussions.

- **Preferred:** open a private report with GitHub's [Report a vulnerability](https://github.com/Mpratyush54/server-automation/security/advisories/new) form.
- **Or email:** legal@cairnpaas.dev with "Security" in the subject.

Include what is affected (component and version), how to reproduce it, and the impact you expect. We confirm receipt within 3 working days, keep you updated, and agree a disclosure date with you once a fix is available. We credit reporters who want to be named.

Please do not access or change other people's data, degrade the license service or cairnpaas.dev, or test against installations you do not own. Good-faith research that follows this policy will not be pursued legally by Neural Nexus.

## Supported versions

Security fixes go into the latest release. Upgrade with `sudo platformctl upgrade` to receive them.

## Scope

In scope: the Cairn platform (API, portal, MCP server), platformctl, the SDKs, the install script at get.cairnpaas.dev, and cairnpaas.dev with its subdomains.

Out of scope: problems in third-party components that are already public upstream (report those upstream), findings that need a compromised server or administrator account, and denial-of-service or volume testing.

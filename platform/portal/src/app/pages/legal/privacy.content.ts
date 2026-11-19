import { LegalDoc } from './legal-doc';

/**
 * Privacy Policy for cairnpaas.dev, Cairn accounts, the license service and install
 * diagnostics. Every statement here must match what the site, platformctl and the license
 * server actually do; change it in the same pull request as any change to what is collected.
 * Change `updated` whenever the text changes.
 */
export const PRIVACY: LegalDoc = {
  title: 'Privacy Policy',
  path: '/privacy',
  updated: '2026-11-19',
  updatedLabel: '19 November 2026',
  summary: [
    'Cairn runs on your servers. Your apps, databases, logs, traces and your users\' data stay there; we never receive them.',
    'This website uses no analytics, no advertising and no tracking cookies.',
    'If you create an account we keep your email address, a hashed password and your license keys and installations, until you delete the account.',
    'Installations send license check-ins and, unless you turn them off, anonymous diagnostics without app data, host names or IP addresses. We delete diagnostics after 180 days.',
    'We do not sell personal data. You can see, correct or delete your data by writing to privacy@cairnpaas.dev.',
  ],
  sections: [
    {
      id: 'who-we-are',
      heading: 'Who we are',
      blocks: [
        { p: 'Cairn is made and run by Neural Nexus, based in India ("Neural Nexus", "we", "us"). We decide how and why the personal data described here is used, so we are its controller (a "Data Fiduciary" under India\'s Digital Personal Data Protection Act, 2023). Neural Nexus is being registered as a company; until then Cairn is run by its founder trading as Neural Nexus, and we will update this page with the registered name.' },
        { p: 'For anything about your personal data, including complaints (grievances), write to privacy@cairnpaas.dev. That address reaches the person responsible for privacy at Neural Nexus.' },
      ],
    },
    {
      id: 'scope',
      heading: 'What this policy covers',
      blocks: [
        { p: 'This policy covers cairnpaas.dev and its subdomains, Cairn accounts and license keys, the license, download and diagnostics services that Cairn installations use, and messages you send us.' },
        { p: 'It does not cover the data inside a Cairn installation. Cairn is self-hosted: the apps, databases, backups, logs, metrics, traces, session replays and other data you and your users put into it stay on your servers and the storage you configure, and we have no access to them. For that data, whoever runs the installation is the controller, and their own privacy policy applies.' },
        { p: 'It also does not cover GitHub, where the Cairn code, issues and releases live. GitHub\'s privacy statement applies there.' },
      ],
    },
    {
      id: 'website',
      heading: 'When you visit the website',
      blocks: [
        { list: [
          'No analytics, advertising or tracking. We do not use Google Analytics or any similar tool, and we do not build profiles of visitors.',
          'Delivery and security logs. The site is served through Cloudflare, which processes your IP address, browser user agent and the pages you request to deliver the site and protect it from attacks. Our own web servers may keep access logs with the same details for up to 30 days, for security and troubleshooting.',
          'Fonts. Pages load the IBM Plex and Caveat fonts from Google Fonts, so your browser sends your IP address and user agent to Google when it fetches them. Google handles that under its own privacy policy.',
          'Videos and images. Product videos come from media.cairnpaas.dev, which is also served through Cloudflare.',
          'Local storage. The site saves your light or dark theme choice in your browser\'s local storage (key platform.theme). It never leaves your device.',
        ] },
        { p: 'The public site sets no cookies. The only cookie is the sign-in cookie described below, and only if you sign in to an account.' },
      ],
    },
    {
      id: 'accounts',
      heading: 'If you create an account',
      blocks: [
        { rows: [
          { label: 'What we keep', text: 'Your email address; your password, stored only as a one-way hash (argon2id); when you signed up and confirmed your email; your license keys, stored only as hashes; and the installations activated with your keys (see the next section).' },
          { label: 'Why', text: 'To give you license keys, show you your installations, and keep your account secure. The legal basis is performing our contract with you (and, under Indian law, your consent when you sign up).' },
          { label: 'Emails', text: 'We send only service emails: the link to confirm your address, and a notice if someone tries to sign up with your address again. No newsletters or marketing.' },
          { label: 'Cookie', text: 'When you sign in, license.cairnpaas.dev sets one strictly necessary cookie, __Host-cairn_session. It is HttpOnly, Secure and SameSite=Strict, only works on that host and lasts up to 7 days or until you sign out. Because it is needed for the service you ask for, it does not need a consent banner.' },
          { label: 'How long', text: 'Until you delete your account. Deleting it from the account page immediately deletes your account, sessions, keys, installations and their diagnostics. Confirmation links expire after 24 hours and expired sessions are deleted automatically.' },
        ] },
      ],
    },
    {
      id: 'installations',
      heading: 'License activation and check-ins from installations',
      blocks: [
        { p: 'When a Cairn installation activates a key, and about once a week after that, it contacts license.cairnpaas.dev.' },
        { rows: [
          { label: 'What is sent', text: 'The license key, a random installation ID, a salted hash of the machine ID (not the machine ID itself), the Cairn version, the installation profile and the number of servers.' },
          { label: 'What is not sent', text: 'No app data, database contents, host names, server IP addresses, user lists or secrets. Your connection\'s IP address is visible to Cloudflare and our servers while the request is handled, but we do not store it with your account or installation.' },
          { label: 'Why', text: 'To check that a key is valid and within its plan, show you your installations, and give licensed installations access to our image registry. The legal basis is performing our contract with you.' },
          { label: 'How long', text: 'An installation that has not checked in for 12 months is deleted automatically, and all of them are deleted when you delete your account.' },
        ] },
        { p: 'Installations that cannot reach the internet can use an offline license instead; then nothing is sent.' },
      ],
    },
    {
      id: 'diagnostics',
      heading: 'Anonymous install diagnostics',
      blocks: [
        { p: 'After installing, upgrading or joining a server, when an install step fails, and with the weekly check-in, platformctl sends a short diagnostics report so we can find and fix installation problems. It says so on screen each time.' },
        { rows: [
          { label: 'What is sent', text: 'The Cairn version and profile; number of servers; processor architecture; operating system release and Kubernetes version; uptime; the name, duration and result of each install step; for failed steps, the error message cut to 300 characters with keys, tokens, passwords, URLs, email addresses, IP addresses and host names removed; the health of each platform component; and counts of projects, environments, deployments and users.' },
          { label: 'What is not sent', text: 'No app data, logs, database contents, names of projects or users, host names, IP addresses or secrets. The sender\'s IP address is not stored.' },
          { label: 'Linking', text: 'Reports are stored with the installation they came from, and so with the account that owns its key, so we can tell installations apart and contact you about a problem if needed. We use them only to make Cairn install and run better, not for licensing decisions or marketing.' },
          { label: 'Turning it off', text: 'Set PLATFORM_DIAGNOSTICS=off in the environment before running platformctl (it is saved for later runs). Enterprise plans can also have diagnostics switched off for their keys.' },
          { label: 'How long', text: 'Deleted after 180 days, and at once when the installation or account is deleted.' },
          { label: 'Legal basis', text: 'Our legitimate interest in making the software reliable, balanced by the limited, redacted content and the opt-out.' },
        ] },
      ],
    },
    {
      id: 'sales',
      heading: 'When you contact us or ask for a quote',
      blocks: [
        { p: 'The Enterprise quote form sends your company name, your name, work email, number of servers and message to license.cairnpaas.dev. We store it and email it to our sales inbox so we can reply and prepare a quote. If bot protection is on, Cloudflare Turnstile may check the request, which involves your IP address. We keep quote requests for up to 24 months, or longer if they lead to a contract, for as long as the law requires us to keep business records.' },
        { p: 'If you email us, we keep the messages as long as needed to answer you and for our records.' },
      ],
    },
    {
      id: 'sharing',
      heading: 'Who we share data with',
      blocks: [
        { p: 'We do not sell or rent personal data, and we do not share it for advertising. We use these service providers, who process data for us under contract:' },
        { list: [
          'Cloudflare, for DNS, content delivery, security, file storage (R2), email delivery and email forwarding.',
          'The provider of the cloud server that runs our license service and database.',
          'An SMTP email provider (such as Brevo), only if Cloudflare email delivery is unavailable.',
        ] },
        { p: 'Google receives your IP address when your browser loads fonts, as described above. We may also disclose data when the law requires it, to protect the rights and safety of users or the public, or to a successor if Neural Nexus or Cairn is reorganised or sold, in which case this policy continues to protect your data.' },
      ],
    },
    {
      id: 'transfers',
      heading: 'Where data is stored',
      blocks: [
        { p: 'Our license service and its database run on a server we manage. Cloudflare and Google operate worldwide, so data may be processed outside your country, including outside India and the European Economic Area. Where the GDPR applies, we rely on our providers\' standard contractual clauses or other approved safeguards for such transfers.' },
      ],
    },
    {
      id: 'security',
      heading: 'How we protect data',
      blocks: [
        { p: 'Passwords, license keys and confirmation and session tokens are stored only as hashes. Connections use HTTPS. Access to production systems is limited and protected. Database backups are taken daily and kept for up to 30 days. No system is perfectly secure; if a breach affects your personal data, we will tell you and the authorities as the law requires.' },
      ],
    },
    {
      id: 'rights',
      heading: 'Your rights',
      blocks: [
        { p: 'Depending on where you live, you can:' },
        { list: [
          'get a summary or copy of the personal data we hold about you;',
          'have it corrected, completed or updated;',
          'have it deleted (you can delete your account yourself from the account page);',
          'withdraw consent you have given, without affecting what was done before;',
          'object to or restrict processing based on our legitimate interests, including diagnostics;',
          'receive your data in a portable format;',
          'nominate someone to exercise your rights if you die or become unable to (India); and',
          'complain to a regulator: the Data Protection Board of India, or the data protection authority where you live or work in the EEA or UK.',
        ] },
        { p: 'Write to privacy@cairnpaas.dev from the email address on your account, or tell us how to identify your data. We reply within 30 days and do not charge for reasonable requests. Please raise a grievance with us first; if we have not resolved it, you may go to the regulator.' },
      ],
    },
    {
      id: 'children',
      heading: 'Children',
      blocks: [
        { p: 'Cairn is a tool for developers and companies and is not meant for children. You must be 18 or older to create an account. If you believe a child has given us personal data, write to privacy@cairnpaas.dev and we will delete it.' },
      ],
    },
    {
      id: 'changes',
      heading: 'Changes to this policy',
      blocks: [
        { p: 'We update this policy when what we collect or how we use it changes. The "Last updated" date at the top shows the latest version. If a change materially affects how we use data we already hold, we email account holders before it takes effect.' },
      ],
    },
  ],
};

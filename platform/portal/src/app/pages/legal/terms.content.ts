import { LegalDoc } from './legal-doc';

/**
 * Terms of Service for cairnpaas.dev, Cairn accounts, license keys and the services the
 * installed software uses. The software itself is licensed by the LICENSE file.
 * Change `updated` whenever the text changes.
 */
export const TERMS: LegalDoc = {
  title: 'Terms of Service',
  path: '/terms',
  updated: '2026-11-19',
  updatedLabel: '19 November 2026',
  summary: [
    'These terms cover this website, your Cairn account, license keys, and the license and diagnostics services that Cairn installations use.',
    'The Cairn software is licensed to you under the Cairn Source-Available License. These terms add to it; they do not replace it.',
    'Cairn runs on your servers. You are responsible for those servers, the apps you run and the data in them. We cannot see that data.',
    'The Personal plan is free for personal use. Use in a company after a 60-day evaluation, or offering Cairn to others, needs an Enterprise plan.',
    'The software and services come as they are, with liability limited as described below. Indian law applies.',
  ],
  sections: [
    {
      id: 'who-we-are',
      heading: 'Who we are and what these terms cover',
      blocks: [
        { p: 'Cairn is made and run by Neural Nexus, based in India ("Neural Nexus", "we", "us"). Neural Nexus is being registered as a company. Until it is, Cairn is run by its founder trading as Neural Nexus, and the registered company takes over these terms once it exists; we will update this page with its registered name.' },
        { p: 'These Terms of Service ("Terms") apply when you visit cairnpaas.dev or its subdomains (the "Site"), create or use a Cairn account, request or use a license key, or use a Cairn installation that talks to our license, download or diagnostics services (together, the "Services").' },
        { p: 'By using the Services you agree to these Terms. If you use them for an organisation, you confirm that you may accept these Terms for it, and "you" includes that organisation. If you do not agree, do not use the Services.' },
      ],
    },
    {
      id: 'software-license',
      heading: 'The Cairn software and its license',
      blocks: [
        { p: 'The Cairn software (the platform, platformctl, SDKs, MCP server and related code) is licensed under the Cairn Source-Available License in the LICENSE file of the Cairn repository. That license decides what you may do with the software, including that running it needs a valid license key and that you may not remove or get around the license check.' },
        { p: 'If these Terms and the LICENSE conflict about use of the software, the LICENSE applies. If you sign an order form or agreement with us for an Enterprise plan, that document applies over both where they conflict.' },
        { p: 'Cairn includes open-source components (for example k3s, Kubernetes components, PostgreSQL, MinIO and others). Each is provided under its own license, and nothing in these Terms limits your rights under those licenses.' },
      ],
    },
    {
      id: 'accounts',
      heading: 'Your account',
      blocks: [
        { list: [
          'You need an account to get a license key. Give a working email address that you control, and keep it up to date.',
          'You must be at least 18 years old, or the age of majority where you live if that is higher.',
          'Keep your password and license keys secret. You are responsible for what happens under your account and keys. Tell us at once at legal@cairnpaas.dev if you think they have been misused.',
          'You may delete your account at any time from the account page. Deleting it revokes your keys; installations that use them stop being licensed.',
        ] },
      ],
    },
    {
      id: 'plans',
      heading: 'Plans and license keys',
      blocks: [
        { rows: [
          { label: 'Personal (free)', text: 'For personal, non-commercial use such as homelabs, learning, side projects and personal websites: up to 3 servers per installation and up to 2 installations, with every feature. A company or other organisation may also use it to evaluate Cairn for up to 60 days.' },
          { label: 'Enterprise (paid)', text: 'Needed for any use by or for a company or organisation after the evaluation, and for offering Cairn to others (for example as a hosted or managed service). Server and installation limits, price and support are set in your quote or order form.' },
        ] },
        { p: 'A license key is personal to the account it was issued to. Do not share, sell or publish keys, and do not use one key to go beyond the limits of its plan. We may revoke a key that is shared, leaked or used beyond its plan, after telling you where we reasonably can.' },
        { p: 'We may change what the plans include. Changes do not reduce an Enterprise plan you have already paid for during its current term.' },
      ],
    },
    {
      id: 'fees',
      heading: 'Fees for Enterprise plans',
      blocks: [
        { list: [
          'Enterprise plans are billed annually in advance, at the price in your quote or order form.',
          'Prices exclude taxes such as GST, which are added where they apply.',
          'Unless your order form says otherwise, plans renew for another year unless either side cancels at least 30 days before the renewal date. We tell you about price changes at least 30 days before they apply to a renewal.',
          'Fees are not refundable, except where the law requires it, where your order form says otherwise, or where we end your plan without cause (then we refund the unused part).',
          'If an invoice is more than 30 days overdue, we may suspend the plan\'s keys after telling you.',
        ] },
      ],
    },
    {
      id: 'your-servers',
      heading: 'Your servers, apps and data',
      blocks: [
        { p: 'Cairn is self-hosted. It runs on servers that you own or rent, and the apps, databases, backups, logs and other data in it stay on your servers and the storage you configure. We do not host, see or have access to that data, and we are not its controller or processor.' },
        { p: 'You are responsible for your servers and for what you run on them: their security, updates, backups, uptime and costs, the apps and content you deploy, and meeting the laws that apply to you and your users, including data protection and privacy laws for the personal data your apps handle.' },
        { p: 'Cairn can change servers, networks, firewalls and data when you tell it to (for example installing, upgrading, restoring or deleting). Read the documentation, test changes, and keep backups that you have checked can be restored.' },
      ],
    },
    {
      id: 'services',
      heading: 'License, download and diagnostics services',
      blocks: [
        { p: 'Cairn installations contact our services to download the license client, activate a key, check in about once a week, and (unless you turn it off) send anonymous install diagnostics. The Privacy Policy explains exactly what is sent and how to turn diagnostics off.' },
        { p: 'We aim to keep these services available but do not promise that they always will be. An installation keeps working for a period without reaching them, and Cairn offers an offline license for servers that cannot reach the internet.' },
      ],
    },
    {
      id: 'acceptable-use',
      heading: 'Acceptable use',
      blocks: [
        { p: 'You agree not to:' },
        { list: [
          'remove, disable or get around the license check, or help anyone else do so;',
          'share, sell or publish license keys, or create accounts to get more free keys than the Personal plan allows;',
          'attack, overload, scrape or probe the Services or other users\' accounts, or test their security without our written permission (report security issues as described in our security policy instead);',
          'use the Services in breach of the law, including export control and sanctions laws; or',
          'misrepresent who you are or your connection with Neural Nexus or Cairn.',
        ] },
        { p: 'What you deploy on your own servers is your responsibility, but you may not use the Services to support activity that is illegal or that harms others.' },
      ],
    },
    {
      id: 'contributions',
      heading: 'Contributions and feedback',
      blocks: [
        { p: 'Contributions to the Cairn repository are covered by the contribution terms in the LICENSE file. If you send us ideas or feedback, we may use them without any obligation to you.' },
      ],
    },
    {
      id: 'ip',
      heading: 'Our intellectual property',
      blocks: [
        { p: 'The Site, the Services and the software belong to Neural Nexus and its licensors. "Cairn" and the Cairn logo are our trademarks. You may refer to Cairn by name, for example to say that you use it, but you may not use the name or logo in a way that suggests we endorse you or your product, or as part of your own product or domain name, without our written permission.' },
      ],
    },
    {
      id: 'disclaimers',
      heading: 'Disclaimers',
      blocks: [
        { p: 'The Site, the Services and the software are provided "as is" and "as available". To the fullest extent the law allows, we give no warranties of any kind, express or implied, including that they are fit for a particular purpose, of satisfactory quality, free of errors, secure, or that they will not lose data. Documentation, examples and answers from support are guidance, not a guarantee.' },
      ],
    },
    {
      id: 'liability',
      heading: 'Limitation of liability',
      blocks: [
        { p: 'To the fullest extent the law allows:' },
        { list: [
          'we are not liable for indirect, incidental, special or consequential losses, or for loss of profits, revenue, data, goodwill or business, even if we were told they might happen;',
          'our total liability for all claims about the Site, the Services and the software is limited to the fees you paid us for Cairn in the 12 months before the event that caused the claim, or USD 100 if you paid nothing.',
        ] },
        { p: 'Nothing in these Terms limits liability that cannot be limited by law, such as liability for fraud, or for death or personal injury caused by negligence.' },
      ],
    },
    {
      id: 'indemnity',
      heading: 'Your responsibility for claims',
      blocks: [
        { p: 'If someone makes a claim against Neural Nexus because of the apps or data you run with Cairn, or because you broke these Terms or the LICENSE, you will cover the reasonable costs and losses that result, to the extent the law allows.' },
      ],
    },
    {
      id: 'termination',
      heading: 'Suspension and termination',
      blocks: [
        { p: 'You may stop using the Services and delete your account at any time. We may suspend or close an account or revoke keys if you seriously or repeatedly break these Terms or the LICENSE, if we must by law, or to protect the Services or other users. We tell you first where we reasonably can, and for paid plans we give you a chance to fix the problem unless it cannot be fixed or the law prevents it.' },
        { p: 'Sections that by their nature should last after termination (for example fees owed, disclaimers, limitation of liability and governing law) continue to apply.' },
      ],
    },
    {
      id: 'changes',
      heading: 'Changes to these terms',
      blocks: [
        { p: 'We may update these Terms. We change the "Last updated" date at the top, and for changes that materially affect your rights we tell account holders by email at least 30 days before they take effect. If you keep using the Services after that, the new Terms apply; if you do not agree, stop using the Services and delete your account.' },
      ],
    },
    {
      id: 'law',
      heading: 'Governing law and disputes',
      blocks: [
        { p: 'These Terms are governed by the laws of India. Please contact us first at legal@cairnpaas.dev so we can try to resolve any dispute informally within 30 days. If that does not work, the courts with jurisdiction over Neural Nexus\'s principal place of business in India have exclusive jurisdiction, except that either side may seek urgent relief in any competent court.' },
        { p: 'If you are a consumer, this does not take away the protection of mandatory consumer laws where you live.' },
      ],
    },
    {
      id: 'general',
      heading: 'General',
      blocks: [
        { list: [
          'These Terms, the LICENSE, the Privacy Policy and any order form are the whole agreement between you and us about the Services.',
          'If part of these Terms cannot be enforced, the rest still applies.',
          'If we do not enforce a right at once, we have not given it up.',
          'You may not transfer your rights under these Terms without our consent. We may transfer them to a successor, including the registered Neural Nexus company or a buyer of the business.',
          'Neither side is responsible for delays caused by events outside its reasonable control.',
        ] },
      ],
    },
  ],
};

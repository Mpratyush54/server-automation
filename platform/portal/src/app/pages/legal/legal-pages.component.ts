import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import { SiteHeaderComponent } from '../../shared/site/site-header.component';
import { SiteFooterComponent } from '../../shared/site/site-footer.component';
import { LEGAL_EMAIL, LegalDoc, OPERATOR, PRIVACY_EMAIL } from './legal-doc';
import { TERMS } from './terms.content';
import { PRIVACY } from './privacy.content';

/** Fields the shared legal template reads. */
abstract class LegalPage {
  abstract doc: LegalDoc;
  operator = OPERATOR;
  legalEmail = LEGAL_EMAIL;
  privacyEmail = PRIVACY_EMAIL;
  legalMailto = `mailto:${LEGAL_EMAIL}`;
  privacyMailto = `mailto:${PRIVACY_EMAIL}`;
}

/** Public Terms of Service (/terms), prerendered for crawlers. */
@Component({
  selector: 'app-terms',
  standalone: true,
  imports: [RouterModule, SiteHeaderComponent, SiteFooterComponent],
  templateUrl: './legal-page.html',
  styleUrl: './legal-page.css',
})
export class TermsComponent extends LegalPage {
  doc = TERMS;
}

/** Public Privacy Policy (/privacy), prerendered for crawlers. */
@Component({
  selector: 'app-privacy',
  standalone: true,
  imports: [RouterModule, SiteHeaderComponent, SiteFooterComponent],
  templateUrl: './legal-page.html',
  styleUrl: './legal-page.css',
})
export class PrivacyComponent extends LegalPage {
  doc = PRIVACY;
}

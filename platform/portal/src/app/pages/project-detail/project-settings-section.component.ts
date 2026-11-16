import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PrivacyTabComponent } from './privacy-tab/privacy-tab.component';

/**
 * Settings section (#185): namespace isolation, project access, SDK tokens and
 * privacy. State and API calls stay in ProjectDetailComponent; this component
 * renders them and emits the user's actions. Role gating is decided by the
 * parent and passed in unchanged.
 */
@Component({
  selector: 'app-project-settings-section',
  standalone: true,
  imports: [CommonModule, FormsModule, PrivacyTabComponent],
  templateUrl: './project-settings-section.component.html',
  styleUrls: ['./project-section-shared.css', './project-settings-section.component.css'],
})
export class ProjectSettingsSectionComponent {
  @Input() project: any;

  // Access
  @Input() members: any[] = [];
  @Input() canManageAccess = false;
  /** Mutated in place by the form; the parent owns the object. */
  @Input() newMember: { email: string; role: string } = { email: '', role: 'developer' };
  @Input() memberBusy = false;
  @Input() memberError = '';
  @Output() grantMember = new EventEmitter<void>();
  @Output() changeMemberRole = new EventEmitter<{ member: any; role: string }>();
  @Output() revokeMember = new EventEmitter<any>();

  // SDK tokens
  @Input() tokens: any[] = [];
  @Input() canCreateSdkTokens = false;
  @Input() canRevokeSdkTokens = false;
  @Input() newKeyName = '';
  @Output() newKeyNameChange = new EventEmitter<string>();
  @Input() newKeyKind: 'server' | 'browser' = 'server';
  @Output() newKeyKindChange = new EventEmitter<'server' | 'browser'>();
  @Input() generatedKeyPlaintext = '';
  @Input() generatedKeyKind: 'server' | 'browser' = 'server';
  @Output() createToken = new EventEmitter<void>();
  @Output() revokeToken = new EventEmitter<string>();
  @Output() clearGeneratedToken = new EventEmitter<void>();

  setKeyName(v: string) { this.newKeyName = v; this.newKeyNameChange.emit(v); }
  setKeyKind(v: 'server' | 'browser') { this.newKeyKind = v; this.newKeyKindChange.emit(v); }
}

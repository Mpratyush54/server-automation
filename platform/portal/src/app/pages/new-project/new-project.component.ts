import { Component, ElementRef, HostListener, OnInit, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { DialogService, ToastService, errorText } from '../../shared/feedback/feedback.service';
import {
  ENVIRONMENTS, EnvName, MEMBER_ROLES, PRIVACY_DEFAULTS, PlanItem, STACKS, STEPS, StepId, WizardDraft,
  buildPlan, domainProblem, emptyDraft, emptyMember, emptyVar, envHostPreview, envLabel, firstInvalidStep,
  isDirty, memberProblems, nameProblem, parseRepo, repoProblem, revisionProblem, stepProblem, usedMembers,
  usedVars, varProblems,
} from './new-project-model';

export type RunStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';
export interface RunItem extends PlanItem { status: RunStatus; error?: string; result?: any }

interface GitStatus {
  state: 'loading' | 'known' | 'unknown';
  github: boolean;
  gitlab: boolean;
  githubOwner?: string;
  gitlabUrl?: string;
}

@Component({
  selector: 'app-new-project',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './new-project.component.html',
  styleUrl: './new-project.component.css',
})
export class NewProjectComponent implements OnInit {
  private api = inject(ApiService);
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  private dialog = inject(DialogService);

  @ViewChild('stepHeading') stepHeading?: ElementRef<HTMLElement>;

  readonly steps = STEPS;
  readonly stacks = STACKS;
  readonly environments = ENVIRONMENTS;
  readonly roles = MEMBER_ROLES;
  readonly envLabel = envLabel;

  draft: WizardDraft = emptyDraft();
  step = 0;
  /** Steps whose fields show errors (visited and left, or Next tried). */
  touched = new Set<StepId>();

  existingNames: string[] = [];
  git: GitStatus = { state: 'loading', github: false, gitlab: false };
  repos: { fullName: string; htmlUrl: string; defaultBranch: string; private: boolean }[] = [];
  repoPick = '';
  suggestedBranch = '';
  users: { id: string; name: string; email: string }[] = [];
  usersLoaded = false;
  selfId: string | null = null;
  canProvision = true;

  /** edit → running → done | partial */
  phase: 'edit' | 'running' | 'done' | 'partial' = 'edit';
  items: RunItem[] = [];
  project: any = null;

  async ngOnInit() {
    const me = this.auth.getUser() || null;
    this.selfId = me?.id || null;
    const role = String(me?.role || '');
    this.canProvision = !role || role === 'admin' || role === 'devops';
    await Promise.all([this.loadNames(), this.loadGit(), this.loadUsers()]);
  }

  private async loadNames() {
    try {
      const list = await firstValueFrom(this.api.getProjects());
      this.existingNames = (Array.isArray(list) ? list : []).map((p: any) => String(p?.name || '')).filter(Boolean);
    } catch { this.existingNames = []; }
  }

  private async loadGit() {
    try {
      const [apps, tokens] = await Promise.all([
        firstValueFrom(this.http.get<any>('/api/settings/integrations/git')).catch(() => null),
        firstValueFrom(this.api.getIntegrations()).catch(() => null),
      ]);
      if (!apps && !tokens) { this.git = { state: 'unknown', github: false, gitlab: false }; return; }
      this.git = {
        state: 'known',
        github: !!(apps?.github?.connected || apps?.github?.linkingTokenFallback || tokens?.resolved?.githubToken),
        gitlab: !!(apps?.gitlab?.connected || tokens?.resolved?.gitlabToken),
        githubOwner: apps?.github?.owner || undefined,
        gitlabUrl: apps?.gitlab?.url || tokens?.gitlabUrl || undefined,
      };
      if (apps?.github?.connected) {
        const res = await firstValueFrom(this.http.get<any>('/api/settings/integrations/github/repositories')).catch(() => null);
        this.repos = Array.isArray(res?.repositories) ? res.repositories : [];
      }
    } catch {
      this.git = { state: 'unknown', github: false, gitlab: false };
    }
  }

  private async loadUsers() {
    try {
      const list = await firstValueFrom(this.api.getUsers());
      this.users = (Array.isArray(list) ? list : [])
        .filter((u: any) => u?.id && u.id !== this.selfId)
        .map((u: any) => ({ id: u.id, name: u.name || u.username || u.email, email: u.email || '' }));
    } catch { this.users = []; }
    this.usersLoaded = true;
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  get current() { return this.steps[this.step]; }
  get problem(): string | null { return stepProblem(this.current.id, this.draft, this.existingNames, this.selfId); }

  stepValid(i: number): boolean {
    return stepProblem(this.steps[i].id, this.draft, this.existingNames, this.selfId) === null;
  }

  /** A step can be opened when every step before it is valid. */
  canVisit(i: number): boolean {
    for (let k = 0; k < i; k++) if (!this.stepValid(k)) return false;
    return true;
  }

  stepState(i: number): 'current' | 'done' | 'todo' {
    if (i === this.step) return 'current';
    return i < this.step || (this.touched.has(this.steps[i].id) && this.stepValid(i)) ? 'done' : 'todo';
  }

  goTo(i: number) {
    if (i === this.step || i < 0 || i >= this.steps.length || !this.canVisit(i)) return;
    this.touched.add(this.current.id);
    this.step = i;
    this.focusHeading();
  }

  next() {
    this.touched.add(this.current.id);
    if (this.problem) return;
    if (this.step < this.steps.length - 1) { this.step++; this.focusHeading(); }
  }

  back() {
    if (this.step > 0) { this.touched.add(this.current.id); this.step--; this.focusHeading(); }
  }

  private focusHeading() {
    setTimeout(() => this.stepHeading?.nativeElement?.focus?.(), 0);
  }

  // ── Field helpers ──────────────────────────────────────────────────────────

  get nameError(): string | null {
    if (!this.draft.name && !this.touched.has('app')) return null;
    return nameProblem(this.draft.name, this.existingNames);
  }
  // Address fields are checked once the person leaves the field (or presses Next), not on every
  // keystroke: a half-typed URL is not a mistake. Once shown, the message updates live.
  blurred = new Set<'repo' | 'domain'>();
  private shows(field: 'repo' | 'domain', step: StepId) { return this.blurred.has(field) || this.touched.has(step); }
  get repoError() { return this.shows('repo', 'code') ? repoProblem(this.draft.repositoryUrl) : null; }
  get revisionError() { return revisionProblem(this.draft.gitRevision); }
  get domainError() { return this.shows('domain', 'environments') ? domainProblem(this.draft.domain) : null; }
  get repoInfo() { return parseRepo(this.draft.repositoryUrl); }
  get varErrors() { return varProblems(this.draft.variables); }
  get memberErrors() { return memberProblems(this.draft.members, this.selfId); }
  get anyDatabase() { return ENVIRONMENTS.some((e) => this.draft.databases[e]); }
  get usedVars() { return usedVars(this.draft.variables); }
  get usedMembers() { return usedMembers(this.draft.members); }
  get gitConnected() { return this.git.github || this.git.gitlab; }
  stackLabel(id: string) { return STACKS.find((s) => s.id === id)?.label || id; }
  roleHint(id: string) { return MEMBER_ROLES.find((r) => r.id === id)?.hint || ''; }
  /** An optional step with nothing filled in: the button reads Skip. */
  isEmptyStep(): boolean {
    const d = this.draft;
    switch (this.current.id) {
      case 'code': return !d.repositoryUrl.trim() && !d.gitRevision.trim();
      case 'data': return !this.anyDatabase;
      case 'settings': return !usedVars(d.variables).length && d.privacy.analytics === PRIVACY_DEFAULTS.analytics
        && d.privacy.replay === PRIVACY_DEFAULTS.replay && d.privacy.scrubIps === PRIVACY_DEFAULTS.scrubIps;
      case 'team': return !usedMembers(d.members).length;
      default: return false;
    }
  }
  roleLabel(id: string) { return MEMBER_ROLES.find((r) => r.id === id)?.label || id; }
  hostPreview(env: EnvName) { return envHostPreview(this.draft.name, env, this.draft.domain); }

  /** Private repositories need the matching provider connection. */
  get repoWarning(): string | null {
    const info = this.repoInfo;
    if (!info || this.git.state !== 'known') return null;
    if (info.provider === 'GitHub' && !this.git.github) return 'GitHub is not connected yet, so only a public repository can be pulled until you connect it.';
    if (info.provider === 'GitLab' && !this.git.gitlab) return 'GitLab is not connected yet, so only a public repository can be pulled until you connect it.';
    return null;
  }

  pickRepo() {
    const r = this.repos.find((x) => x.fullName === this.repoPick);
    if (!r) return;
    this.draft.repositoryUrl = r.htmlUrl || `https://github.com/${r.fullName}`;
    this.suggestedBranch = r.defaultBranch || '';
  }

  addVar() { this.draft.variables.push(emptyVar()); }
  removeVar(i: number) { this.draft.variables.splice(i, 1); }
  addMember() { this.draft.members.push(emptyMember()); }
  removeMember(i: number) { this.draft.members.splice(i, 1); }
  userName(id: string): string {
    const u = this.users.find((x) => x.id === id);
    return u ? u.name : id;
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  get busy() { return this.phase === 'running'; }
  get doneCount() { return this.items.filter((i) => i.status === 'done').length; }
  get failedItems() { return this.items.filter((i) => i.status === 'failed'); }
  get credentials() { return this.items.filter((i) => i.kind === 'database' && i.status === 'done' && i.result); }

  async create() {
    const bad = firstInvalidStep(this.draft, this.existingNames, this.selfId);
    if (bad >= 0) {
      this.steps.slice(0, bad + 1).forEach((s) => this.touched.add(s.id));
      this.step = bad;
      this.focusHeading();
      return;
    }
    this.items = buildPlan(this.draft, (id) => this.userName(id)).map((p) => ({ ...p, status: 'pending' as RunStatus }));
    this.project = null;
    await this.runRemaining();
  }

  /** Runs every item that is not done yet, in order. */
  async runRemaining() {
    this.phase = 'running';
    for (const item of this.items) {
      if (item.status === 'done') continue;
      if (item.kind !== 'project' && !this.project) { item.status = 'blocked'; item.error = undefined; continue; }
      await this.runItem(item);
    }
    this.finish();
  }

  async retry(item: RunItem) {
    if (this.busy) return;
    if (item.kind === 'project') { await this.runRemaining(); return; }
    this.phase = 'running';
    await this.runItem(item);
    this.finish();
  }

  async retryFailed() {
    if (!this.busy) await this.runRemaining();
  }

  /** The project itself failed: go back to the form with everything kept. */
  editAgain() {
    this.phase = 'edit';
    this.items = [];
    this.step = 0;
    this.focusHeading();
  }

  private finish() {
    const failed = this.items.filter((i) => i.status === 'failed' || i.status === 'blocked').length;
    this.phase = failed ? 'partial' : 'done';
    if (!failed) this.toast.ok(`Project ${this.project?.name || this.draft.name} is ready.`);
    else if (this.project) this.toast.error(`Project ${this.project.name} was created, but ${failed} ${failed === 1 ? 'item' : 'items'} failed. Retry them below.`);
    else this.toast.error('The project was not created. Check the reason below.');
  }

  private async runItem(item: RunItem) {
    item.status = 'running';
    item.error = undefined;
    try {
      item.result = await this.exec(item);
      item.status = 'done';
    } catch (err: any) {
      item.status = 'failed';
      item.error = this.reason(item, err);
    }
  }

  private reason(item: RunItem, err: any): string {
    const text = errorText(err, 'The request failed.');
    if (item.kind === 'project' && err?.status === 409) {
      const code = err?.error?.code;
      if (code === 'repository_in_use' || (!code && /repository/i.test(text))) {
        return `${text}. Each repository deploys to one project: go back and choose another repository, or remove it from the other project first.`;
      }
      return `${text}. A project with this name exists (it may have been deleted earlier). Go back and pick another name.`;
    }
    if (err?.status === 403) return `${text}. Your role is not allowed to do this; ask an admin or DevOps user.`;
    return text;
  }

  private envId(name: EnvName): string {
    const env = (this.project?.environments || []).find((e: any) => e?.name === name);
    if (!env?.id) throw new Error(`The ${name} environment was not found on the new project`);
    return env.id;
  }

  private async exec(item: RunItem): Promise<any> {
    const d = this.draft;
    switch (item.kind) {
      case 'project': {
        const body: any = { name: d.name.trim(), stack: d.stack };
        if (d.description.trim()) body.description = d.description.trim();
        if (d.repositoryUrl.trim()) body.repositoryUrl = d.repositoryUrl.trim();
        if (d.gitRevision.trim()) body.gitRevision = d.gitRevision.trim();
        if (d.domain.trim()) body.domain = d.domain.trim();
        const p = await firstValueFrom(this.api.createProject(body));
        if (!p?.id) throw new Error('The server did not return the new project');
        this.project = p;
        return p;
      }
      case 'database':
        return firstValueFrom(this.api.provisionDatabase(this.project.id, item.env!));
      case 'variable': {
        const v = item.variable!;
        return firstValueFrom(this.api.setEnvironmentVar(this.project.id, v.key, {
          environmentId: v.scope === 'all' ? null : this.envId(v.scope), value: v.value, secret: v.secret,
        }));
      }
      case 'consent':
        return firstValueFrom(this.api.updateProjectPrivacyConsentDefaults(this.project.id, { analytics: d.privacy.analytics, replay: d.privacy.replay }));
      case 'scrubbing':
        return firstValueFrom(this.api.updateProjectPrivacyScrubbing(this.project.id, { scrubIps: d.privacy.scrubIps }));
      case 'member': {
        const m = item.member!;
        return firstValueFrom(this.api.addProjectMember(this.project.id, m.userId ? { userId: m.userId, role: m.role } : { email: m.email, role: m.role }));
      }
    }
  }

  statusWord(s: RunStatus): string {
    return { pending: 'Waiting', running: 'Working', done: 'Done', failed: 'Failed', blocked: 'Waits for the project' }[s];
  }
  statusTone(s: RunStatus): string {
    return s === 'done' ? 'status-ok' : s === 'running' ? 'status-warn' : s === 'failed' ? 'status-down' : '';
  }

  async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.ok('Copied');
    } catch {
      this.toast.error('Copy did not work. Select the text and copy it yourself.');
    }
  }

  // ── Leaving ────────────────────────────────────────────────────────────────

  get hasUnsaved(): boolean {
    if (this.phase === 'done') return this.credentials.length > 0;
    if (this.phase === 'edit') return isDirty(this.draft);
    return true;
  }

  async confirmLeave(): Promise<boolean> {
    if (!this.hasUnsaved) return true;
    if (this.phase === 'edit' || (this.phase === 'partial' && !this.project)) {
      return this.dialog.confirm({
        title: 'Leave without creating the project?',
        message: 'What you entered here is not saved and will be lost.',
        confirmLabel: 'Leave', cancelLabel: 'Keep editing', danger: true,
      });
    }
    if (this.phase === 'running') {
      return this.dialog.confirm({
        title: 'Leave while Cairn is still creating the project?',
        message: 'Steps already sent keep running, but you will not see which ones failed or the database passwords.',
        confirmLabel: 'Leave', cancelLabel: 'Stay', danger: true,
      });
    }
    if (this.phase === 'done') {
      return this.dialog.confirm({
        title: 'Saved the database passwords?',
        message: 'Cairn shows each database password only once. Copy them before you leave this page.',
        confirmLabel: 'Leave', cancelLabel: 'Stay',
      });
    }
    return this.dialog.confirm({
      title: 'Leave with items not created?',
      message: this.credentials.length
        ? 'Some items failed. Database passwords shown here are not shown again, so copy them first.'
        : 'Some items failed. You can add them later from the project page.',
      confirmLabel: 'Leave', cancelLabel: 'Stay',
    });
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(e: BeforeUnloadEvent) {
    if (this.hasUnsaved) { e.preventDefault(); e.returnValue = ''; }
  }
}

// Renders a standalone Angular component's template to static HTML at build
// time, for the public pages that are served before Angular boots.
//
// The component's own TypeScript is transpiled and instantiated with stubbed
// Angular decorators, so the template is evaluated against the real initial
// state, getters and constants (for example TOPOLOGY_STEPS). The template is
// parsed with Angular's own compiler. Anything this renderer does not
// understand (an unknown binding, pipe, directive, block or expression) throws,
// so a template change can never silently ship broken or half-rendered HTML.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import * as ng from '@angular/compiler';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const META = Symbol('component metadata');
const INPUTS = Symbol('component inputs');
const FILE = Symbol('component source file');

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
// DOM properties that render as the attribute of the same name.
const ATTRIBUTE_PROPERTIES = new Set(['src', 'poster', 'href', 'id', 'title', 'alt']);
const BOOLEAN_PROPERTIES = new Set(['hidden', 'disabled']);

export class PrerenderError extends Error {}
const fail = message => { throw new PrerenderError(message); };

const escapeText = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeAttribute = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

// --- Loading component classes from TypeScript -----------------------------

/**
 * Services a public component may inject, as the values they have before the
 * browser runs anything. ThemeService reads the stored theme in the browser;
 * the static page shows the system-theme icon until then.
 */
const SERVICE_STUBS = {
  ThemeService: () => ({ choice: () => 'system', cycle() {} }),
  // Change detection only runs in the browser.
  ChangeDetectorRef: () => ({ detectChanges() {}, markForCheck() {} }),
  // The pricing form only calls these after a submit in the browser.
  LicenseAccountService: () => ({}),
  ToastService: () => ({}),
};

const coreStubs = {
  Component: meta => cls => {
    cls[META] = meta;
    return cls;
  },
  Injectable: () => cls => cls,
  Input: () => (prototype, key) => {
    const cls = prototype.constructor;
    if (!Object.hasOwn(cls, INPUTS)) cls[INPUTS] = new Set();
    cls[INPUTS].add(key);
  },
  ViewChild: () => () => {},
  ViewChildren: () => () => {},
  inject: token => {
    const stub = SERVICE_STUBS[token?.name];
    if (!stub) fail(`Prerender cannot inject ${token?.name ?? token}; add a static stub to SERVICE_STUBS`);
    return stub();
  },
  signal: value => {
    const read = () => value;
    read.set = next => { value = next; };
    return read;
  },
  DOCUMENT: Symbol('DOCUMENT'),
  ElementRef: class ElementRef {},
  ChangeDetectorRef: class ChangeDetectorRef {},
};
const strictModule = (name, stubs) => new Proxy(stubs, {
  get(target, key) {
    if (key === '__esModule') return true;
    if (typeof key === 'symbol' || Object.hasOwn(target, key)) return target[key];
    return fail(`Prerender has no stub for ${name}.${key}`);
  },
});
const MODULE_STUBS = {
  '@angular/core': strictModule('@angular/core', coreStubs),
  '@angular/router': strictModule('@angular/router', { RouterModule: class RouterModule {} }),
};

// No DOM, timers or storage: component constructors must not need a browser.
const sandbox = vm.createContext({ console });
const moduleCache = new Map();

export function loadTypeScriptModule(file) {
  file = resolve(file);
  if (moduleCache.has(file)) return moduleCache.get(file).exports;
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      useDefineForClassFields: false,
      importHelpers: false,
      esModuleInterop: false,
    },
  });
  const module = { exports: {} };
  moduleCache.set(file, module);
  const load = specifier => {
    if (Object.hasOwn(MODULE_STUBS, specifier)) return MODULE_STUBS[specifier];
    if (specifier.startsWith('.')) return loadTypeScriptModule(resolve(dirname(file), `${specifier}.ts`));
    return fail(`Prerender cannot import ${specifier} (from ${file})`);
  };
  vm.runInContext(`(function (exports, require, module) {\n${outputText}\n})`, sandbox, { filename: file })(module.exports, load, module);
  for (const value of Object.values(module.exports)) {
    if (typeof value === 'function' && Object.hasOwn(value, META)) value[FILE] = file;
  }
  return module.exports;
}

function componentMeta(cls) {
  const meta = cls?.[META];
  if (!meta) fail(`${cls?.name ?? cls} is not an @Component`);
  return meta;
}

function componentTemplate(cls) {
  const meta = componentMeta(cls);
  if (typeof meta.template === 'string') return meta.template;
  if (meta.templateUrl) return readFileSync(resolve(dirname(cls[FILE]), meta.templateUrl), 'utf8');
  return fail(`${cls.name} has no template`);
}

function componentStyles(cls) {
  const meta = componentMeta(cls);
  const styles = [meta.styles ?? []].flat();
  for (const url of [meta.styleUrl ?? [], meta.styleUrls ?? []].flat()) {
    styles.push(readFileSync(resolve(dirname(cls[FILE]), url), 'utf8'));
  }
  const selector = componentMeta(cls).selector;
  return styles.map(css => {
    if (/::ng-deep|:host-context/.test(css)) fail(`${cls.name} styles use ::ng-deep or :host-context, which the prerender does not scope`);
    if (/<\/style/i.test(css)) fail(`${cls.name} styles contain </style`);
    // Emulated encapsulation scopes :host to the component element.
    return css.replace(/:host\(([^)]*)\)/g, `${selector}$1`).replace(/:host\b/g, selector);
  }).join('\n');
}

function componentRegistry(cls, registry = new Map()) {
  const meta = componentMeta(cls);
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(meta.selector ?? '')) fail(`${cls.name} needs a plain element selector to be prerendered`);
  registry.set(meta.selector, cls);
  for (const imported of meta.imports ?? []) {
    if (typeof imported === 'function' && imported[META] && !registry.has(imported[META].selector)) componentRegistry(imported, registry);
  }
  return registry;
}

// --- Expressions -----------------------------------------------------------

class Scope {
  constructor(component, parent = null) {
    this.component = component;
    this.parent = parent;
    this.vars = new Map();
  }
  child() {
    return new Scope(this.component, this);
  }
  lookup(name) {
    for (let scope = this; scope; scope = scope.parent) {
      if (scope.vars.has(name)) return scope.vars.get(name);
    }
    if (this.component !== null && typeof this.component === 'object' && name in this.component) return this.component[name];
    return fail(`Unknown name "${name}" in template expression`);
  }
}

function readProperty(receiver, name, source) {
  if (receiver === null || receiver === undefined) fail(`Cannot read "${name}" of ${receiver} in "${source}"`);
  if (!(name in Object(receiver))) fail(`Unknown property "${name}" in "${source}"`);
  return receiver[name];
}

const BINARY = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b,
  '===': (a, b) => a === b, '!==': (a, b) => a !== b, '==': (a, b) => a == b, '!=': (a, b) => a != b,
  '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b,
};

function evaluate(node, scope, source) {
  const run = child => evaluate(child, scope, source);
  if (node instanceof ng.ASTWithSource) return evaluate(node.ast, scope, node.source ?? source);
  if (node instanceof ng.LiteralPrimitive) return node.value;
  if (node instanceof ng.LiteralArray) return node.expressions.map(run);
  if (node instanceof ng.ParenthesizedExpression) return run(node.expression);
  if (node instanceof ng.NonNullAssert) return run(node.expression);
  if (node instanceof ng.PrefixNot) return !run(node.expression);
  if (node instanceof ng.TypeofExpression) return typeof run(node.expression);
  if (node instanceof ng.Conditional) return run(node.condition) ? run(node.trueExp) : run(node.falseExp);
  if (node instanceof ng.TemplateLiteral) {
    return node.elements.map((element, index) => element.text + (index < node.expressions.length ? String(run(node.expressions[index])) : '')).join('');
  }
  if (node instanceof ng.ThisReceiver) return scope.component;
  if (node instanceof ng.PropertyRead || node instanceof ng.SafePropertyRead) {
    if (node.receiver instanceof ng.ImplicitReceiver && !(node.receiver instanceof ng.ThisReceiver)) return scope.lookup(node.name);
    const receiver = run(node.receiver);
    if (node instanceof ng.SafePropertyRead && (receiver === null || receiver === undefined)) return null;
    return readProperty(receiver, node.name, source);
  }
  if (node instanceof ng.KeyedRead || node instanceof ng.SafeKeyedRead) {
    const receiver = run(node.receiver);
    if (node instanceof ng.SafeKeyedRead && (receiver === null || receiver === undefined)) return null;
    return readProperty(receiver, run(node.key), source);
  }
  if (node instanceof ng.Call || node instanceof ng.SafeCall) {
    const target = node.receiver;
    let owner;
    let fn;
    if (target instanceof ng.PropertyRead && target.receiver instanceof ng.ImplicitReceiver && !(target.receiver instanceof ng.ThisReceiver)) {
      fn = scope.lookup(target.name);
      owner = scope.component;
    } else if (target instanceof ng.PropertyRead || target instanceof ng.SafePropertyRead) {
      owner = run(target.receiver);
      if (target instanceof ng.SafePropertyRead && (owner === null || owner === undefined)) return null;
      fn = readProperty(owner, target.name, source);
    } else {
      fn = run(target);
    }
    if (node instanceof ng.SafeCall && (fn === null || fn === undefined)) return null;
    if (typeof fn !== 'function') fail(`"${source}" calls something that is not a function`);
    return fn.apply(owner, node.args.map(run));
  }
  // Unary extends Binary, so check it first.
  if (node instanceof ng.Unary) {
    const value = run(node.expr);
    if (node.operator === '-') return -value;
    if (node.operator === '+') return +value;
    return fail(`Unsupported unary operator ${node.operator} in "${source}"`);
  }
  if (node instanceof ng.Binary) {
    if (node.operation === '&&') return run(node.left) && run(node.right);
    if (node.operation === '||') return run(node.left) || run(node.right);
    if (node.operation === '??') return run(node.left) ?? run(node.right);
    const operation = BINARY[node.operation];
    if (!operation) fail(`Unsupported operator ${node.operation} in "${source}"`);
    return operation(run(node.left), run(node.right));
  }
  if (node instanceof ng.BindingPipe) return fail(`Pipes are not supported by the prerender: "${source}"`);
  return fail(`Unsupported template expression (${node?.constructor?.name}) in "${source}"`);
}

const expressionSource = value => value?.source?.trim() ?? '';
const evaluateBinding = (value, scope) => evaluate(value, scope, expressionSource(value));

// --- Template nodes --------------------------------------------------------

const templateCache = new Map();
function parse(template, url) {
  if (templateCache.has(template)) return templateCache.get(template);
  const parsed = ng.parseTemplate(template, url, { preserveWhitespaces: true });
  if (parsed.errors?.length) fail(`Template errors in ${url}:\n${parsed.errors.map(String).join('\n')}`);
  templateCache.set(template, parsed.nodes);
  return parsed.nodes;
}

const stripNamespace = name => name.replace(/^:(svg|xhtml|math):/, '').replace(/^:([a-z]+):/, '$1:');

const ANGULAR_STATIC_ATTRIBUTE = /^(routerLink\w+|ng[A-Z]\w*|queryParams\w*|formControl\w*|formGroup\w*|cdk\w*|mat\w*)$/;

function renderElement(node, scope, context) {
  const name = stripNamespace(node.name);
  if (name === 'ng-container' || name === 'ng-template' || name === 'ng-content') fail(`<${name}> is not supported by the prerender`);
  const component = context.registry.get(name);
  const attributes = new Map();
  const classes = [];
  let routerLink = null;
  let fragment = null;
  let instance = null;
  if (component) instance = new component();
  const inputs = component?.[INPUTS] ?? new Set();

  for (const attribute of node.attributes) {
    const key = stripNamespace(attribute.name);
    if (key === 'routerLink') { routerLink = attribute.value; continue; }
    if (key === 'fragment') { fragment = attribute.value; continue; }
    if (ANGULAR_STATIC_ATTRIBUTE.test(key)) fail(`Unhandled Angular attribute ${key} on <${name}>`);
    if (instance && inputs.has(key)) instance[key] = attribute.value;
    if (key === 'class') classes.push(...attribute.value.split(/\s+/).filter(Boolean));
    else attributes.set(key, attribute.value);
  }
  for (const input of node.inputs) {
    const source = expressionSource(input.value);
    const value = evaluateBinding(input.value, scope);
    if (input.type === ng.BindingType.Property && (input.name === 'routerLink' || input.name === 'fragment')) {
      // Only plain strings: an array or object link needs the router to resolve it.
      if (typeof value !== 'string' || (input.name === 'routerLink' && !value.startsWith('/'))) {
        fail(`[${input.name}]="${source}" must be a string${input.name === 'routerLink' ? ' starting with /' : ''} to be prerendered`);
      }
      if (input.name === 'routerLink') routerLink = value;
      else fragment = value;
      continue;
    }
    if (input.type === ng.BindingType.Attribute) {
      if (value === null || value === undefined) attributes.delete(input.name);
      else attributes.set(input.name, String(value));
    } else if (input.type === ng.BindingType.Class) {
      if (value) classes.push(input.name);
    } else if (input.type !== ng.BindingType.Property) {
      fail(`Unhandled binding [${input.name}]="${source}" on <${name}>`);
    } else if (instance && inputs.has(input.name)) {
      instance[input.name] = value;
    } else if (input.name === 'class') {
      if (typeof value !== 'string') fail(`[class]="${source}" must be a string to be prerendered`);
      classes.push(...value.split(/\s+/).filter(Boolean));
    } else if (BOOLEAN_PROPERTIES.has(input.name)) {
      if (value) attributes.set(input.name, '');
      else attributes.delete(input.name);
    } else if (input.name === 'controls' && name === 'video') {
      // Keep the static `controls` attribute: without JavaScript the native
      // controls are the only way to play the video (the cover button is
      // hidden by a <noscript> style). Angular takes over on startup.
      if (!attributes.has('controls')) fail('<video [controls]> needs a static controls attribute as the no-JavaScript fallback');
    } else if (ATTRIBUTE_PROPERTIES.has(input.name)) {
      if (value === null || value === undefined) attributes.delete(input.name);
      else attributes.set(input.name, String(value));
    } else {
      fail(`Unhandled property binding [${input.name}]="${source}" on <${name}>`);
    }
  }
  if (routerLink !== null) {
    if (attributes.has('href')) fail(`<${name}> has both routerLink and href`);
    attributes.set('href', routerLink + (fragment ? `#${fragment}` : ''));
  } else if (fragment !== null) {
    fail(`<${name}> has fragment without routerLink`);
  }
  // Event bindings and template references only matter once Angular runs.

  const parts = [name];
  if (classes.length) parts.push(`class="${escapeAttribute([...new Set(classes)].join(' '))}"`);
  for (const [key, value] of attributes) parts.push(value === '' ? key : `${key}="${escapeAttribute(value)}"`);
  const open = `<${parts.join(' ')}>`;
  if (VOID_ELEMENTS.has(name)) {
    if (node.children.length) fail(`<${name}> cannot have children`);
    return open;
  }
  let inner;
  if (component) {
    if (node.children.some(child => !(child instanceof ng.TmplAstText) || child.value.trim())) fail(`<${name}> has projected content, which the prerender does not support`);
    inner = renderComponentInstance(component, instance, context);
  } else {
    inner = renderNodes(node.children, scope, context);
  }
  return `${open}${inner}</${name}>`;
}

function renderNodes(nodes, parentScope, context) {
  const scope = parentScope.child();
  let html = '';
  for (const node of nodes) html += renderNode(node, scope, context);
  return html;
}

function renderNode(node, scope, context) {
  if (node instanceof ng.TmplAstText) return escapeText(node.value);
  if (node instanceof ng.TmplAstBoundText) {
    const interpolation = node.value.ast;
    if (!(interpolation instanceof ng.Interpolation)) fail(`Unsupported text binding: ${expressionSource(node.value)}`);
    let text = '';
    interpolation.strings.forEach((string, index) => {
      text += string;
      if (index < interpolation.expressions.length) {
        const value = evaluate(interpolation.expressions[index], scope, expressionSource(node.value));
        text += value === null || value === undefined ? '' : String(value);
      }
    });
    return escapeText(text);
  }
  if (node instanceof ng.TmplAstElement) return renderElement(node, scope, context);
  if (node instanceof ng.TmplAstIfBlock) {
    for (const branch of node.branches) {
      if (branch.expression === null) return renderNodes(branch.children, scope, context);
      const value = evaluateBinding(branch.expression, scope);
      if (value) {
        const branchScope = scope.child();
        if (branch.expressionAlias) branchScope.vars.set(branch.expressionAlias.name, value);
        return renderNodes(branch.children, branchScope, context);
      }
    }
    return '';
  }
  if (node instanceof ng.TmplAstForLoopBlock) {
    const value = evaluateBinding(node.expression, scope);
    if (value === null || value === undefined || typeof value[Symbol.iterator] !== 'function') fail(`@for over a non-iterable: ${expressionSource(node.expression)}`);
    const items = Array.from(value);
    if (!items.length) return node.empty ? renderNodes(node.empty.children, scope, context) : '';
    return items.map((item, index) => {
      const itemScope = scope.child();
      itemScope.vars.set(node.item.name, item);
      const implicit = { $index: index, $first: index === 0, $last: index === items.length - 1, $even: index % 2 === 0, $odd: index % 2 === 1, $count: items.length };
      for (const variable of node.contextVariables) {
        if (!Object.hasOwn(implicit, variable.value)) fail(`Unknown @for context variable ${variable.value}`);
        itemScope.vars.set(variable.name, implicit[variable.value]);
      }
      return renderNodes(node.children, itemScope, context);
    }).join('');
  }
  if (node instanceof ng.TmplAstSwitchBlock) {
    const value = evaluateBinding(node.expression, scope);
    const groups = node.groups ?? node.cases.map(item => ({ cases: [item], children: item.children }));
    let fallback = null;
    for (const group of groups) {
      for (const item of group.cases) {
        if (item.expression === null) fallback = group;
        else if (evaluateBinding(item.expression, scope) === value) return renderNodes(group.children, scope, context);
      }
    }
    return fallback ? renderNodes(fallback.children, scope, context) : '';
  }
  if (node instanceof ng.TmplAstLetDeclaration) {
    scope.vars.set(node.name, evaluateBinding(node.value, scope));
    return '';
  }
  return fail(`Unsupported template node (${node?.constructor?.name}) in the prerender`);
}

function renderComponentInstance(cls, instance, context) {
  context.rendered.add(cls);
  return renderNodes(parse(componentTemplate(cls), cls[FILE] ?? cls.name), new Scope(instance), context);
}

/**
 * Render a component and the components it imports.
 * `state` sets the initial values the static HTML represents; every key must
 * already exist on the component, so renamed fields fail instead of drifting.
 */
export function renderComponent(cls, { state = {}, inputs = {} } = {}) {
  const instance = new cls();
  for (const [key, value] of Object.entries({ ...inputs, ...state })) {
    if (!(key in instance)) fail(`${cls.name} has no field "${key}" for the prerendered initial state`);
    instance[key] = value;
  }
  const context = { registry: componentRegistry(cls), rendered: new Set() };
  const selector = componentMeta(cls).selector;
  const body = renderComponentInstance(cls, instance, context);
  const css = [...context.rendered].map(componentStyles).join('\n');
  return { html: `<${selector}>${body}</${selector}>`, css };
}

/** Render a template string against a plain context object (used by tests). */
export function renderTemplate(template, component = {}) {
  return renderNodes(parse(template, 'inline-template'), new Scope(component), { registry: new Map(), rendered: new Set() });
}

/** Fail if rendered output still contains Angular template syntax. */
export function assertNoAngularSyntax(html, label) {
  const leftover = html.match(/\{\{|\}\}|@(if|else|for|empty|switch|case|default|defer|let)\b|\s\(\w[\w.-]*\)=|\s\[[\w.-]+\]=|\s\*ng\w+=|\srouterLink\w*=|\s#\w+[\s>=]|_ngcontent|_nghost|&#64;/);
  if (leftover) fail(`Prerendered ${label} still contains Angular syntax: ${JSON.stringify(leftover[0])} near ${JSON.stringify(html.slice(Math.max(0, leftover.index - 60), leftover.index + 60))}`);
}

import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

const TOKENS_FILE = path.join(process.cwd(), 'data', 'bootstrap-tokens.json');
const HISTORY_FILE = path.join(process.cwd(), 'data', 'bootstrap-history.json');

function ensureDataDir(): void {
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function readTokens(): Record<string, { expiresAt: string; used: boolean }> {
  ensureDataDir();
  if (!fs.existsSync(TOKENS_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeTokens(tokens: Record<string, { expiresAt: string; used: boolean }>): void {
  ensureDataDir();
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf-8');
}

function appendHistory(entry: any): void {
  ensureDataDir();
  let history: any[] = [];
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    } catch {
      history = [];
    }
  }
  history.push(entry);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { hostname, token, components } = body;

    if (!hostname || !token) {
      return NextResponse.json({ error: 'hostname and token are required' }, { status: 400 });
    }

    const tokens = readTokens();
    const stored = tokens[token];

    if (!stored) {
      return NextResponse.json({ error: 'Invalid bootstrap token' }, { status: 401 });
    }

    if (stored.used) {
      return NextResponse.json({ error: 'Token already used' }, { status: 401 });
    }

    if (new Date(stored.expiresAt) < new Date()) {
      return NextResponse.json({ error: 'Token expired' }, { status: 401 });
    }

    tokens[token].used = true;
    writeTokens(tokens);

    const entry = {
      id: Date.now(),
      nodeIp: body.nodeIp || 'unknown',
      hostname,
      components: components || [],
      status: 'initiated',
      date: new Date().toISOString(),
    };
    appendHistory(entry);

    const log = [
      `[${new Date().toISOString()}] Bootstrap initiated for hostname: ${hostname}`,
      ...(components || []).map((c: string) => `[${new Date().toISOString()}] Component "${c}" registered`),
      `[${new Date().toISOString()}] Bootstrap started`,
    ].join('\n');

    return NextResponse.json({ status: 'initiated', log });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

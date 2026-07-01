import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

const TOKENS_FILE = path.join(process.cwd(), 'data', 'bootstrap-tokens.json');

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

export async function GET(request: NextRequest) {
  try {
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const tokens = readTokens();
    tokens[token] = { expiresAt, used: false };
    writeTokens(tokens);

    return NextResponse.json({ token, expiresAt });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

const HISTORY_FILE = path.join(process.cwd(), 'data', 'bootstrap-history.json');

function ensureDataDir(): void {
  const dataDir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function readHistory(): any[] {
  ensureDataDir();
  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2), 'utf-8');
    return [];
  }
  const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  try {
    const history = readHistory();
    return NextResponse.json({ history });
  } catch (error: any) {
    return NextResponse.json({ error: error.message, history: [] }, { status: 500 });
  }
}

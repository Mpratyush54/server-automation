"""Generate frozen neural narration; pronunciation spelling never reaches captions.

Uses the Edge online speech service through edge-tts. No credentials are stored.
Run from any directory with --voice to audition a different narrator.
"""
import argparse
import asyncio
import json
from pathlib import Path
import re
import subprocess

import edge_tts

ROOT = Path(__file__).resolve().parent


async def generate(project, voice, rate):
    root = ROOT / project
    meta_path = root / 'audio_meta.json'
    meta = json.loads(meta_path.read_text(encoding='utf-8-sig'))
    script = (root / 'SCRIPT.md').read_text(encoding='utf-8')
    lines = re.findall(r'^    (.+)$', script, re.MULTILINE)
    if len(lines) != len(meta['voices']):
        raise ValueError(f'{project}: script and scene count differ')
    pronunciations = json.loads((ROOT / 'pronunciation.json').read_text(encoding='utf-8'))
    for entry, text in zip(meta['voices'], lines):
        spoken = text
        for official, pronunciation in pronunciations.items():
            spoken = re.sub(r'\b' + re.escape(official) + r'\b', pronunciation, spoken)
        target = root / entry['path']
        mp3 = target.with_suffix('.neural.mp3')
        cues = []
        narration = edge_tts.Communicate(spoken, voice, rate=rate, boundary='SentenceBoundary')
        with mp3.open('wb') as output:
            async for event in narration.stream():
                if event['type'] == 'audio':
                    output.write(event['data'])
                elif event['type'] == 'SentenceBoundary':
                    caption = event['text']
                    for official, pronunciation in pronunciations.items():
                        caption = caption.replace(pronunciation, official)
                    cues.append({'start': event['offset'] / 10_000_000,
                                 'end': (event['offset'] + event['duration']) / 10_000_000,
                                 'text': caption})
        if not mp3.stat().st_size or not cues:
            raise ValueError(f'{project}: empty audio or sentence timing for {target.name}')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(mp3), '-ar', '24000',
                        '-ac', '1', '-c:a', 'pcm_s16le', str(target)], check=True)
        info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
                          'format=duration', '-of', 'json', str(target)], text=True))
        entry.update(duration_s=float(info['format']['duration']), words=[], cues=cues,
                     provider='Microsoft Edge online speech', voice=voice, rate=rate)
        print(f'{project}/{target.name}: {entry["duration_s"]:.3f}s', flush=True)
    meta['narration'] = {'provider': 'Microsoft Edge online speech', 'voice': voice,
                         'pronunciations': '../pronunciation.json'}
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--voice', default='en-US-AvaMultilingualNeural')
    parser.add_argument('--rate', default='-6%')
    parser.add_argument('--project', choices=['platform-explainer', 'platform-short'])
    args = parser.parse_args()
    for project in ([args.project] if args.project else ['platform-explainer', 'platform-short']):
        await generate(project, args.voice, args.rate)


if __name__ == '__main__':
    asyncio.run(main())

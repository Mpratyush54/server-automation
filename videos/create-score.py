"""Create an original, deterministic instrumental bed without samples or APIs.

Run with Python + numpy + soundfile. The score leaves the speech band open:
warm sine pads, a soft arpeggio, bass, and restrained percussive ticks.
"""
import json
from pathlib import Path
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent
RATE = 44100

def frequency(midi):
    return 440 * 2 ** ((midi - 69) / 12)

def score(duration):
    length = int((duration + .1) * RATE)
    stereo = np.zeros((length, 2), dtype=np.float64)
    rng = np.random.default_rng(54)
    beat = 60 / 96
    chords = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 55, 60, 64], [55, 59, 62, 67]]

    def add(start, signal, pan=0):
        offset = round(start * RATE)
        size = min(len(signal), length - offset)
        if size <= 0:
            return
        stereo[offset:offset + size, 0] += signal[:size] * np.sqrt((1 - pan) / 2)
        stereo[offset:offset + size, 1] += signal[:size] * np.sqrt((1 + pan) / 2)

    for bar in range(int(duration / (4 * beat)) + 1):
        chord = chords[bar % len(chords)]
        start = bar * 4 * beat
        t = np.arange(int((4 * beat + 1) * RATE)) / RATE
        envelope = np.minimum(t / .4, 1) * np.minimum(np.maximum(4 * beat + 1 - t, 0) / 1.2, 1)
        for index, note in enumerate(chord):
            signal = (.028 * np.sin(2 * np.pi * frequency(note) * t)
                      + .008 * np.sin(2 * np.pi * frequency(note) * 2 * t)) * envelope
            add(start, signal, (index - 1.5) / 3)
        for step in range(8):
            note = chord[[0, 2, 1, 3, 2, 1, 3, 2][step]] + 12
            t = np.arange(int(1.25 * RATE)) / RATE
            bell = np.sin(2 * np.pi * frequency(note) * t) + .2 * np.sin(2 * np.pi * frequency(note) * 2 * t)
            bell *= .055 * (1 - np.exp(-t * 300)) * np.exp(-t * 4.5)
            add(start + step * beat / 2, bell, -.4 if step % 2 else .4)
        for step in range(4):
            t = np.arange(int(.45 * RATE)) / RATE
            bass = .075 * np.sin(2 * np.pi * frequency(chord[0] - 12) * t) * (1 - np.exp(-t * 120)) * np.exp(-t * 7)
            add(start + step * beat, bass)
            t = np.arange(int(.08 * RATE)) / RATE
            noise = rng.normal(0, 1, len(t))
            tick = .009 * np.r_[0, np.diff(noise)] * np.exp(-t * 95)
            add(start + step * beat + beat / 2, tick, .25)
    # A small stereo echo gives the plucks a sense of space.
    delay = int(.1875 * RATE)
    stereo[delay:] += .13 * stereo[:-delay, ::-1].copy()
    t = np.arange(length) / RATE
    stereo *= (np.minimum(t / .5, 1) * np.clip((duration - t) / 1.8, 0, 1))[:, None]
    stereo *= .65 / max(np.max(np.abs(stereo)), 1e-6)
    return stereo

for name in ['platform-explainer', 'platform-short']:
    root = ROOT / name
    meta_path = root / 'audio_meta.json'
    meta = json.loads(meta_path.read_text(encoding='utf-8-sig'))
    duration = meta.get('total_duration_s') or sum(voice['duration_s'] for voice in meta['voices'])
    output = root / '.media/audio/bgm/original-score.wav'
    output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(output, score(duration), RATE, subtype='PCM_16')
    meta['bgm'] = {'path': '.media/audio/bgm/original-score.wav', 'volume': .15, 'duration_s': duration, 'query': 'Original instrumental: warm minimal electronic, 96 BPM, no samples'}
    meta_path.write_text(json.dumps(meta, indent=2) + '\n', encoding='utf-8')
    print(f'{name}: original score {duration:.3f}s')

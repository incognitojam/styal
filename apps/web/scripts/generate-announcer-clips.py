"""Regenerate bundled announcer fragments with macOS Daniel and FFmpeg.

Pass phrase names to render only those, e.g. `departed`; with none, every phrase is rendered.
"""

import array
import os
from pathlib import Path
import subprocess
import sys
import wave

root = Path(__file__).resolve().parents[3]
os.chdir(root)
subprocess.run(['git', 'check-ignore', '-q', '.scratch'], check=True)
scratch = root / '.scratch/announcer-clip-render'
scratch.mkdir(parents=True, exist_ok=True)
output = root / 'apps/web/src/assets/announcer/phrases'
output.mkdir(parents=True, exist_ok=True)
phrases = {
    'prefix': 'Pull request',
    'cancelled-prefix': 'We are sorry to announce that pull request',
    'ready': 'is ready to depart. It is awaiting a member of train crew.',
    'departed': 'has departed.',
    'ci-failure': 'is delayed. This is due to a CI failure.',
    'merge-conflict': 'is delayed. This is due to a merge conflict.',
    'queue-failure': 'is delayed. This is due to a problem in the merge queue.',
    'stack-delayed': 'is delayed. This is due to a slower running train ahead.',
    'changes-requested': 'is being held at a red signal.',
    'cancelled': 'has been cancelled.',
    **{f'digit-{i}': str(i) for i in range(10)},
}
only = set(sys.argv[1:])
for name, text in phrases.items():
    if only and name not in only:
        continue
    aiff = scratch / f'{name}.aiff'
    subprocess.run(['say', '-v', 'Daniel', '-r', '160', '-o', str(aiff), text], check=True)
    raw = subprocess.check_output(['ffmpeg','-v','error','-i',str(aiff),'-ar','44100','-ac','1','-f','s16le','-'])
    samples = array.array('h', raw)
    active = [i for i,v in enumerate(samples) if abs(v)>100]
    first = max(0, active[0] - 441)
    last = min(len(samples), active[-1] + 1985)
    trimmed = scratch / f'{name}.wav'
    with wave.open(str(trimmed), 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(44100)
        f.writeframes(samples[first:last].tobytes())
    # Match the sentence cadence without changing the pitch of standalone digits.
    tempo = 'atempo=1.6,' if name.startswith('digit-') else ''
    effects = (
        tempo + 'highpass=f=280,lowpass=f=3800,'
        'acompressor=threshold=-18dB:ratio=4,'
        'aecho=0.8:0.6:90|180:0.25|0.12,loudnorm=I=-24:TP=-3:LRA=7'
    )
    subprocess.run([
        'ffmpeg', '-v', 'error', '-y', '-i', str(trimmed), '-af', effects,
        '-ar', '44100', '-map_metadata', '-1', '-b:a', '96k',
        str(output / f'{name}.mp3'),
    ], check=True)
    print(name, round((last - first) / 44100, 3))

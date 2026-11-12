# 120 BPM synth score for the brag video; every event sits on the 16th-note grid.
import numpy as np, wave, sys
SR, BPM, DUR = 44100, 120, 21.0
B = 60 / BPM
N = int(SR * DUR)
L = np.zeros(N); R = np.zeros(N)
rng = np.random.default_rng(7)
hz = lambda m: 440 * 2 ** ((m - 69) / 12)

def add(sig, t, gain=1.0, pan=0.0):
    i = int(round(t * SR)); j = min(N, i + len(sig))
    if i >= N: return
    s = sig[:j - i] * gain
    L[i:j] += s * np.sqrt((1 - pan) / 2) * 1.414; R[i:j] += s * np.sqrt((1 + pan) / 2) * 1.414

def env(n, a, d):  # attack, exp decay (seconds)
    t = np.arange(n) / SR
    return np.minimum(t / max(a, 1e-4), 1) * np.exp(-t / d)

def lp(x, cutoff):  # one-pole lowpass
    a = np.exp(-2 * np.pi * cutoff / SR); y = np.empty_like(x); acc = 0.0
    for k in range(len(x)): acc = (1 - a) * x[k] + a * acc; y[k] = acc
    return y

def kick():
    n = int(.35 * SR); t = np.arange(n) / SR
    f = 45 + 75 * np.exp(-t / .045)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / .16)

def hat():
    n = int(.06 * SR); x = rng.standard_normal(n); x = np.diff(x, prepend=0)
    return x * env(n, .001, .018) * .5

def clap():
    n = int(.22 * SR); x = rng.standard_normal(n)
    x = lp(x, 2600) - lp(x, 900)
    return x * env(n, .002, .07) * 2.2

def pluck(m, d=.35, bright=2200):
    n = int(d * SR * 1.6); t = np.arange(n) / SR; f = hz(m)
    x = sum(np.sin(2 * np.pi * f * h * t) / h for h in range(1, 6))
    return lp(x * env(n, .003, d), bright)

def bell(m, d=.6):
    n = int(d * SR * 2.5); t = np.arange(n) / SR; f = hz(m)
    return (np.sin(2 * np.pi * f * t) + .35 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t / .12)) * env(n, .002, d)

def pad(notes, dur):
    n = int(dur * SR); t = np.arange(n) / SR; x = np.zeros(n)
    for m in notes:
        for det in (-0.08, 0.08):
            x += np.sin(2 * np.pi * hz(m + det) * t) + .3 * np.sin(2 * np.pi * 2 * hz(m + det) * t)
    a = np.minimum(t / .5, 1) * np.minimum((dur - t) / .4, 1)
    return lp(x * a, 1800) / len(notes)

def whoosh(end, length=.45):  # filtered noise swell landing on a cut
    n = int(length * SR); x = rng.standard_normal(n); t = np.arange(n) / SR
    x = lp(x, 1400) - lp(x, 300)
    add(x * (t / length) ** 2 * np.exp(-((length - t) / .08) ** 2 * .0) , end - length, .22)

# progression: Am F C G, one chord per bar (2 s)
CH = [(57, 60, 64), (53, 57, 60), (48, 55, 64), (55, 59, 62)]
ROOT = [45, 41, 48, 43]
bars = int(np.ceil(DUR / (4 * B)))
for b in range(bars):
    t0 = b * 4 * B; ch = CH[b % 4]
    d = min(4 * B + .4, DUR - t0)
    add(pad([c + 12 for c in ch], d), t0, .055 if t0 < 18 else .07)

for k in range(int(DUR / (B / 2))):  # 8th-note grid
    t = k * B / 2; beat = k // 2; off = k % 2; bar = int(t // (4 * B))
    in_body = 1.0 <= t < 18.5
    breath = 3.0 <= t < 5.0
    # kick: four on the floor, half-time in the reveal, stops at the outro
    if not off and in_body and (not breath or beat % 2 == 0):
        add(kick(), t, .55)
    if off and 1.0 <= t < 18 and not breath:
        add(hat(), t, .10, .3)
    if not off and beat % 2 == 1 and 5.0 <= t < 18:
        add(clap(), t, .12, -.15)
    # bass: 8th-note pluck on the root, octave jump on the last 8th of each beat pair
    if 1.0 <= t < 18.5 and not (breath and off):
        r = ROOT[bar % 4] - 12 + (12 if k % 4 == 3 else 0)
        add(pluck(r + 12, .18, 900), t, .30)

# bell motif in the hook and outro (chord tones, up then down)
MOT = [0, 1, 2, 1]
for k in range(int(DUR / (B / 2))):
    t = k * B / 2
    if t < 3.0 or t >= 18.0:
        ch = CH[int(t // (4 * B)) % 4]
        add(bell(ch[MOT[k % 4]] + 24, .35), t, .07 if t < 20 else .07 * (1 - (t - 20)), .25 * (-1) ** k)

# sfx, in key and on the grid
for i in range(6):  # cover pops, ascending A minor pentatonic
    add(pluck([69, 72, 74, 76, 79, 81][i], .12, 4000), .5 + i * .25, .09, -.4 + .16 * i)
for c in (3.0, 5.0, 14.5, 18.0):
    whoosh(c)
for c, m in ((5.5, 76), (9.5, 76), (10.0, 79), (10.5, 81), (11.5, 72), (12.5, 76), (13.5, 79)):  # UI clicks
    add(bell(m + 12, .05), c, .05, .2)
# slider drag: rising soft tone 6.5 -> 7.5
n = int(SR * 1.0); t = np.arange(n) / SR
add(np.sin(2 * np.pi * np.cumsum(440 + 440 * (t / 1.0)) / SR) * np.sin(np.pi * t / 1.0) ** 2, 6.5, .025)
add(bell(81 + 12, .1), 7.5, .06)  # release
for i in range(5):  # network: soft blips as PDFs arrive
    add(bell([76, 79, 81, 84, 88][i], .1), 16.0 + i * .25 + .5, .03, .5)

mix = np.stack([L, R], 1)
fade = np.ones(N); fl = int(.9 * SR); fade[-fl:] = np.linspace(1, 0, fl) ** 1.5
mix *= fade[:, None]
mix = np.tanh(mix * 1.1)
mix *= 0.89 / np.abs(mix).max()
out = sys.argv[1]
with wave.open(out, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype('<i2').tobytes())
print('ok', out, N / SR)

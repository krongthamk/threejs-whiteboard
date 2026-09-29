"""Render retained S3 result artifacts. Requires matplotlib in a separate Python environment."""
import json
import pathlib
import struct
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

path = pathlib.Path(sys.argv[1])
result = json.loads(path.read_text())
samples = result['samples']
minutes = [(sample['at'] - result['startedAt']) / 60_000 for sample in samples]
binary = path.with_suffix('.latencies.f64le').read_bytes()
latencies = list(struct.unpack('<' + 'd' * (len(binary) // 8), binary))
fig, axes = plt.subplots(4, 1, figsize=(11, 13), constrained_layout=True)
fig.set_facecolor('white')
name = 'Production server: authentication + SQLite' if result['config'].get('production') else 'In-memory writer-register candidate'
fig.suptitle(f"{name}\n40 clients · 5 document ops/s/client · 20 Hz cursors/client · {result['measuredSeconds']:.3f} s", fontsize=15)
blue, orange, red = '#2464a5', '#b86817', '#be3c38'

axes[0].plot(minutes, [sample['cpuPctOneCore'] for sample in samples], color=blue, linewidth=1)
axes[0].axhline(70, color=red, linestyle='--', label='70% gate')
axes[0].set_ylim(0, max(80, result['cpuPctOneCore']['max'] * 1.1))
axes[0].set_ylabel('CPU (% of one core)')
axes[0].set_title(f"Dedicated server CPU — maximum {result['cpuPctOneCore']['max']:.2f}%", loc='left', fontsize=11)
axes[0].legend(loc='upper right')

axes[1].plot(minutes, [sample['rss'] / 1048576 for sample in samples], color=blue, linewidth=1, label='RSS')
axes[1].plot(minutes, [sample['heapUsed'] / 1048576 for sample in samples], color=orange, linewidth=1, label='Used JS heap')
axes[1].axvspan(0, 5, color='#d8dde3', alpha=.5, label='5-minute warmup')
axes[1].set_ylabel('Memory (MiB)')
axes[1].set_title(f"Memory — post-warmup slopes RSS {result['memory']['rssSlopeMiBPerMinuteAfterWarmup']:+.4f}, heap {result['memory']['heapSlopeMiBPerMinuteAfterWarmup']:+.4f} MiB/min", loc='left', fontsize=11)
axes[1].legend(loc='upper right', ncol=3)

axes[2].plot(minutes, [sample['documentStats'][0]['retainedStructs'] for sample in samples], color=blue, label='All retained structs')
axes[2].plot(minutes, [sample['documentStats'][0]['deletedStructs'] for sample in samples], color=orange, label='Deleted structs')
axes[2].set_ylabel('Yjs structs')
axes[2].set_title('Retained CRDT metadata — fixed writer identities and bounded content', loc='left', fontsize=11)
axes[2].set_ylim(bottom=0)
axes[2].legend(loc='lower right')
axes[2].set_xlabel('Elapsed minutes')
for axis in axes[:3]:
    axis.set_xlim(0, max(30, max(minutes)))
    axis.grid(alpha=.18)

# The sorted raw file retains every observation; only the drawn curve is thinned.
step = max(1, len(latencies) // 4000)
indices = list(range(0, len(latencies), step)) + [len(latencies) - 1]
axes[3].plot([max(.01, latencies[index]) for index in indices], [(index + 1) / len(latencies) * 100 for index in indices], color=blue)
axes[3].axvline(150, color=red, linestyle='--', label='150 ms p95 gate')
axes[3].axhline(95, color='#777', linestyle=':', linewidth=1)
axes[3].set_xscale('log')
axes[3].set_xlabel('Gesture-to-ack round trip (ms, logarithmic scale)')
axes[3].set_ylabel('Acknowledgements (%)')
axes[3].set_ylim(0, 100)
axes[3].set_title(f"All {len(latencies):,} acknowledged gestures — p95 {result['roundTripMs']['p95']:.2f} ms; maximum {result['roundTripMs']['max']:.2f} ms", loc='left', fontsize=11)
axes[3].grid(alpha=.18)
axes[3].legend(loc='lower right')
for suffix in ['.png', '.pdf']:
    fig.savefig(path.with_suffix(suffix), dpi=150, metadata={'Title': name, 'Creator': 'S3 raw-result plotter'})
print(path.with_suffix('.png'))

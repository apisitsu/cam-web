import { useEffect, useRef } from 'react';
import { invalidate } from '@react-three/fiber';
import { useCamStore } from '../stores/camStore.js';
import { getBuf } from '../engine/bufferCache.js';
import { timeAt, segmentAtTime } from '../engine/gcode/path.js';
import { perTick } from '../engine/view/playback.js';

// Animation loop: advance the playhead while playing. Paced by *machine time*,
// not segment count — a helix tessellates into tens of thousands of tiny
// segments (T3 is 91% of them) while a face mill is a few long moves, so a
// segment-paced run parks on the helix and never shows the other tools. Time
// pacing gives every operation screen-time proportional to how long it runs.
export function usePlayback(playing, speed) {
  const playTimeRef = useRef(0);
  useEffect(() => {
    if (!playing) return undefined;
    const startPath = getBuf().path;
    if (!startPath) return undefined;
    // Resume from wherever the playhead sits (0 after a restart).
    playTimeRef.current = timeAt(startPath, useCamStore.getState().playhead);
    const id = setInterval(() => {
      // The path is read per tick rather than captured, so a re-parse mid-run is
      // picked up **without** this effect depending on `bufVer`. It must not:
      // carving bumps `bufVer` on every step, so with "cut with playback" on the
      // loop was torn down and rebuilt constantly, and each rebuild snapped the
      // time cursor to `timeAt(playhead)` — the *end* of the segment in progress.
      // Playback then advanced a whole segment per carve, running at the speed of
      // the worker instead of the speed setting.
      const path = getBuf().path;
      if (!path) return;
      const totalT = path.totalTime || 1;
      // 40 ms per tick; the whole program spans PLAY_BASE_SECONDS at 1×.
      playTimeRef.current += perTick(totalT, speed);
      const k = segmentAtTime(path, playTimeRef.current);
      useCamStore.getState().setPlayhead(k);
      useCamStore.setState({ playT: playTimeRef.current }); // smooth marker interpolation
      if (k >= path.count) useCamStore.getState().pause();
      invalidate(); // wake up the demand-mode canvas
    }, 40);
    return () => clearInterval(id);
  }, [playing, speed]);
}

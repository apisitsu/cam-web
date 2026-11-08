import { useEffect, useRef } from 'react';
import { autoSimKey, shouldAutoSimulate } from '../engine/view/autoSim.js';

// ---- Simulate on its own, once the setup says what to simulate ----------
//
// A program, a stated billet and an origin are the three things that make
// "what will this make?" answerable. Opt-in via `autoSimEnabled` (off by
// default) so a session that only wants the backplot never carves; when on,
// `autoSimKey` describes the setup as a string so the run happens once per
// setup rather than once per render — see `engine/view/autoSim.js`.
export function useAutoSimulate({
  gcode, stockEnabled, stockSize, stockOrigin, partDatum, aIndex, mode,
  autoSimEnabled, playing, simStatus, sketching, simulate,
}) {
  const autoKey = autoSimKey({
    gcode, stockEnabled, stockSize, stockOrigin, datum: partDatum, aIndex, mode,
  });
  const lastAutoKey = useRef(null);
  useEffect(() => {
    if (!autoSimEnabled) return;
    if (!shouldAutoSimulate({
      key: autoKey,
      last: lastAutoKey.current,
      playing,
      running: simStatus === 'running',
      sketching,
    })) return;
    lastAutoKey.current = autoKey;
    simulate();
  }, [autoSimEnabled, autoKey, playing, simStatus, sketching, simulate]);
}

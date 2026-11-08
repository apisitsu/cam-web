import { useCallback, useState } from 'react';
import { useFeatureStore } from '../stores/featureStore.js';

// While the edge handle is dragged, drop the width transition so the column
// tracks the pointer instead of easing behind it.
export function useTreeResize() {
  const [treeResizing, setTreeResizing] = useState(false);
  const startTreeResize = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = useFeatureStore.getState().treeWidth;
    setTreeResizing(true);
    const onMove = (ev) => useFeatureStore.getState().setTreeWidth(startW + (ev.clientX - startX));
    const onUp = () => {
      setTreeResizing(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);
  return { treeResizing, startTreeResize };
}

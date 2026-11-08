import { useEffect } from 'react';
import { Button, Space } from 'antd';
import { applyProject } from '../lib/projectIO.js';
import { readDraft, clearDraft, startAutosave, suspendAutosave } from '../lib/autosave.js';

// Auto-save draft: mirror the drawing (sketches, feature tree, program) to
// localStorage on a debounce, and on load offer back whatever a previous
// session left. Cleared on an explicit Save (library or file) or New project.
export function useDraftAutosave(notification) {
  useEffect(() => {
    const draft = readDraft();
    if (draft) {
      const key = 'cam-autosave-draft';
      notification.info({
        key,
        message: 'Unsaved work from a previous session',
        description: `Last change ${new Date(draft.at).toLocaleString()}.`,
        duration: 0,
        actions: (
          <Space>
            <Button
              size="small"
              type="primary"
              onClick={() => {
                notification.destroy(key);
                suspendAutosave(() => applyProject(draft.project)).catch(() => {});
              }}
            >
              Restore
            </Button>
            <Button size="small" onClick={() => { clearDraft(); notification.destroy(key); }}>
              Discard
            </Button>
          </Space>
        ),
      });
    }
    return startAutosave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

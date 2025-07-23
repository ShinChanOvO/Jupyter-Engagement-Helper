// ---------------------------------------------------------------------------
// @ts-nocheck  – demo：关闭严格 TS 检查
// ---------------------------------------------------------------------------
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { NotebookPanel, INotebookTracker } from '@jupyterlab/notebook';
import { MarkdownCellModel } from '@jupyterlab/cells';

/* ------------------------------------------------------------------ */
/* Types & State Management                                           */
/* ------------------------------------------------------------------ */

interface Summary {
  runCnt: number;
  errCnt: number;
  activeMs: number;
}

// The state for each notebook panel
interface PanelState {
  summary: Summary;      // In-memory cache of the summary
  saveTimeout: number;   // ID for the debounced save timer
  activityInterval: number;
}

const panelState = new WeakMap<NotebookPanel, PanelState>();
const SAVE_DEBOUNCE_MS = 750; // Wait 750ms after the last change before saving to file
const ACTIVITY_INTERVAL_MS = 5000;

/* ------------------------------------------------------------------ */
/* JupyterLab Extension                                               */
/* ------------------------------------------------------------------ */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyter-engagement-helper-final-v2',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    console.log('[engagement] Activated with debounced-save logic.');

    tracker.widgetAdded.connect((_, panel) => attach(panel));
    app.restored.then(() => {
      tracker.forEach(panel => attach(panel));
    });
  }
};
export default plugin;

/* ------------------------------------------------------------------ */
/* Attach Listeners to a Single NotebookPanel                         */
/* ------------------------------------------------------------------ */
function attach(panel: NotebookPanel) {
  if (panelState.has(panel)) {
    return;
  }
  
  panel.sessionContext.ready.then(() => {
    if (panelState.has(panel) || panel.isDisposed) {
      return;
    }
    
    console.log(`[attach] Notebook ready, attaching to ${panel.context.path}`);

    // --- FIX: LOAD ONCE ---
    // Load the summary from metadata and create our in-memory state object
    const nbMd = panel.content.model.metadata;
    const store = nbMd.get ? (nbMd.get('engage') ?? {}) : (nbMd.engage ?? {});
    const summary: Summary = store.summary ?? { runCnt: 0, errCnt: 0, activeMs: 0 };
    
    panelState.set(panel, {
        summary: summary,
        saveTimeout: 0,
        activityInterval: 0
    });

    // Display what we loaded
    showStoredSummary(panel);

    // Attach event listeners
    panel.sessionContext.session?.kernel?.anyMessage.connect((_, args) => {
      const msg = args.msg;
      if (msg.header.msg_type === 'execute_input') {
        updateInMemorySummary(panel, { addRun: 1 });
        trackActiveTime(panel);
      } else if (msg.header.msg_type === 'error') {
        updateInMemorySummary(panel, { addErr: 1 });
        trackActiveTime(panel);
      }
    });

    // Cleanup on close
    panel.disposed.connect(() => {
      const state = panelState.get(panel);
      if (state) {
        clearTimeout(state.saveTimeout);
        clearInterval(state.activityInterval);
      }
      panelState.delete(panel);
      console.log(`[attach] Cleaned up ${panel.context.path}`);
    });

  }).catch(error => {
    console.error(`Failed to attach to notebook ${panel.context.path}:`, error);
  });
}

function trackActiveTime(panel: NotebookPanel) {
  const state = panelState.get(panel);
  if (!state || state.activityInterval) return;

  updateInMemorySummary(panel, { addMs: ACTIVITY_INTERVAL_MS });
  
  state.activityInterval = window.setInterval(() => {
    updateInMemorySummary(panel, { addMs: ACTIVITY_INTERVAL_MS });
  }, ACTIVITY_INTERVAL_MS);
}

/* ------------------------------------------------------------------ */
/* Core Logic: In-Memory Update & Debounced Save                      */
/* ------------------------------------------------------------------ */

function updateInMemorySummary(
  panel: NotebookPanel,
  updates: { addRun?: number; addErr?: number; addMs?: number }
) {
  const state = panelState.get(panel);
  if (!state) return;

  // --- FIX: Update the in-memory summary object directly ---
  const { summary } = state;
  summary.runCnt += updates.addRun ?? 0;
  summary.errCnt += updates.addErr ?? 0;
  summary.activeMs += updates.addMs ?? 0;
  
  console.log('[update] In-memory summary is now:', summary);

  // Update the UI immediately
  updateSummaryUI(panel, summary);
  
  // --- FIX: Debounce the save-to-file operation ---
  clearTimeout(state.saveTimeout); // Clear any previous pending save
  state.saveTimeout = window.setTimeout(() => {
    persistSummaryToFile(panel);
  }, SAVE_DEBOUNCE_MS);
}

function persistSummaryToFile(panel: NotebookPanel) {
    const state = panelState.get(panel);
    const nbModel = panel.content?.model;
    if (!state || !nbModel) return;

    console.log(`%c[save] Persisting to file:`, 'color: green; font-weight: bold;', state.summary);

    const nbMd = nbModel.metadata;
    const store = nbMd.get ? (nbMd.get('engage') ?? {}) : (nbMd.engage ?? {});
    const newData = { ...store, summary: state.summary };
    nbMd.set ? nbMd.set('engage', newData) : (nbMd.engage = newData);
}

/* ------------------------------------------------------------------ */
/* UI Update Functions                                                */
/* ------------------------------------------------------------------ */

function showStoredSummary(panel: NotebookPanel) {
  const state = panelState.get(panel);
  if (state) {
    console.log('[show] Displaying loaded summary:', state.summary);
    updateSummaryUI(panel, state.summary);
  }
}

function updateSummaryUI(panel: NotebookPanel, s: Summary) {
  const nb = panel.content;
  const TAG = 'engage-summary';

  const md = `**Engagement Summary (auto-generated)**

| Metric | Value |
|:---|---:|
| Run count | ${s.runCnt} |
| Error count | ${s.errCnt} |
| Active time (min) | ${Math.round(s.activeMs / 60000)} |`.trim();

  const w: any = nb.widgets.find(c => {
    if (c.model?.type !== 'markdown') return false;
    const tags = c.model.metadata.get ? c.model.metadata.get('tags') : c.model.metadata.tags;
    return Array.isArray(tags) && tags.includes(TAG);
  });

  if (w) {
    const model = w.model;
    if (model && model.sharedModel) {
      if (model.sharedModel.getSource() !== md) {
        model.sharedModel.setSource(md);
      }
    }
    return;
  }

  // If no cell is found, create one
  if (nb.model && nb.model.contentFactory) {
    const factory = nb.model.contentFactory;
    const newCell = factory.createMarkdownCell({
      cell: {
        cell_type: 'markdown',
        source: md,
        metadata: { tags: [TAG] }
      }
    });
    nb.model.cells.insert(0, newCell);
  }
}// ---------------------------------------------------------------------------
// @ts-nocheck  – demo：关闭严格 TS 检查
// ---------------------------------------------------------------------------
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { NotebookPanel, INotebookTracker } from '@jupyterlab/notebook';
import { MarkdownCellModel } from '@jupyterlab/cells';

/* ------------------------------------------------------------------ */
/* Types & State Management                                           */
/* ------------------------------------------------------------------ */

interface Summary {
  runCnt: number;
  errCnt: number;
  activeMs: number;
}

// The state for each notebook panel
interface PanelState {
  summary: Summary;      // In-memory cache of the summary
  saveTimeout: number;   // ID for the debounced save timer
  activityInterval: number;
}

const panelState = new WeakMap<NotebookPanel, PanelState>();
const SAVE_DEBOUNCE_MS = 750; // Wait 750ms after the last change before saving to file
const ACTIVITY_INTERVAL_MS = 5000;

/* ------------------------------------------------------------------ */
/* JupyterLab Extension                                               */
/* ------------------------------------------------------------------ */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyter-engagement-helper-persistent', // Final version ID
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    console.log('[engagement] Activated with persistent save-on-exit logic.');

    tracker.widgetAdded.connect((_, panel) => attach(panel));
    app.restored.then(() => {
      tracker.forEach(panel => attach(panel));
    });

    // --- FINAL FIX: SAVE ON EXIT ---
    // This listener triggers when you try to refresh or close the tab.
    window.addEventListener('beforeunload', () => {
      console.log('[engagement] Unload event detected, forcing a save for all notebooks...');
      // Iterate over every open notebook tracked by JupyterLab
      tracker.forEach(panel => {
        if (panel && !panel.isDisposed) {
            // Immediately save any pending changes for this notebook
            persistSummaryToFile(panel);
        }
      });
    });
  }
};
export default plugin;

/* ------------------------------------------------------------------ */
/* Attach Listeners to a Single NotebookPanel                         */
/* ------------------------------------------------------------------ */
function attach(panel: NotebookPanel) {
  if (panelState.has(panel)) {
    return;
  }
  
  panel.sessionContext.ready.then(() => {
    if (panelState.has(panel) || panel.isDisposed) {
      return;
    }
    
    console.log(`[attach] Notebook ready, attaching to ${panel.context.path}`);

    // Load the summary from metadata and create our in-memory state object
    const nbMd = panel.content.model.metadata;
    const store = nbMd.get ? (nbMd.get('engage') ?? {}) : (nbMd.engage ?? {});
    const summary: Summary = store.summary ?? { runCnt: 0, errCnt: 0, activeMs: 0 };
    
    panelState.set(panel, {
        summary: summary,
        saveTimeout: 0,
        activityInterval: 0
    });

    // Display what we loaded
    showStoredSummary(panel);

    // Attach event listeners
    panel.sessionContext.session?.kernel?.anyMessage.connect((_, args) => {
      const msg = args.msg;
      if (msg.header.msg_type === 'execute_input') {
        updateInMemorySummary(panel, { addRun: 1 });
        trackActiveTime(panel);
      } else if (msg.header.msg_type === 'error') {
        updateInMemorySummary(panel, { addErr: 1 });
        trackActiveTime(panel);
      }
    });

    // Cleanup on close
    panel.disposed.connect(() => {
      const state = panelState.get(panel);
      if (state) {
        clearTimeout(state.saveTimeout);
        clearInterval(state.activityInterval);
      }
      panelState.delete(panel);
      console.log(`[attach] Cleaned up ${panel.context.path}`);
    });

  }).catch(error => {
    console.error(`Failed to attach to notebook ${panel.context.path}:`, error);
  });
}

function trackActiveTime(panel: NotebookPanel) {
  const state = panelState.get(panel);
  if (!state || state.activityInterval) return;

  updateInMemorySummary(panel, { addMs: ACTIVITY_INTERVAL_MS });
  
  state.activityInterval = window.setInterval(() => {
    updateInMemorySummary(panel, { addMs: ACTIVITY_INTERVAL_MS });
  }, ACTIVITY_INTERVAL_MS);
}

/* ------------------------------------------------------------------ */
/* Core Logic: In-Memory Update & Debounced Save                      */
/* ------------------------------------------------------------------ */

function updateInMemorySummary(
  panel: NotebookPanel,
  updates: { addRun?: number; addErr?: number; addMs?: number }
) {
  const state = panelState.get(panel);
  if (!state) return;

  // Update the in-memory summary object directly
  const { summary } = state;
  summary.runCnt += updates.addRun ?? 0;
  summary.errCnt += updates.addErr ?? 0;
  summary.activeMs += updates.addMs ?? 0;

  // Update the UI immediately
  updateSummaryUI(panel, summary);
  
  // Debounce the save-to-file operation
  clearTimeout(state.saveTimeout); // Clear any previous pending save
  state.saveTimeout = window.setTimeout(() => {
    persistSummaryToFile(panel);
  }, SAVE_DEBOUNCE_MS);
}

function persistSummaryToFile(panel: NotebookPanel) {
    const state = panelState.get(panel);
    const nbModel = panel.content?.model;
    if (!state || !nbModel) return;

    // Before saving, cancel any pending debounced save to avoid redundancy
    clearTimeout(state.saveTimeout);

    console.log(`%c[save] Persisting summary to file:`, 'color: green; font-weight: bold;', state.summary);

    const nbMd = nbModel.metadata;
    const store = nbMd.get ? (nbMd.get('engage') ?? {}) : (nbMd.engage ?? {});
    const newData = { ...store, summary: state.summary };
    nbMd.set ? nbMd.set('engage', newData) : (nbMd.engage = newData);
}

/* ------------------------------------------------------------------ */
/* UI Update Functions                                                */
/* ------------------------------------------------------------------ */

function showStoredSummary(panel: NotebookPanel) {
  const state = panelState.get(panel);
  if (state) {
    console.log('[show] Displaying loaded summary:', state.summary);
    updateSummaryUI(panel, state.summary);
  }
}

function updateSummaryUI(panel: NotebookPanel, s: Summary) {
  const nb = panel.content;
  const TAG = 'engage-summary';

  const md = `**Engagement Summary (auto-generated)**

| Metric | Value |
|:---|---:|
| Run count | ${s.runCnt} |
| Error count | ${s.errCnt} |
| Active time (min) | ${Math.round(s.activeMs / 60000)} |`.trim();

  const w: any = nb.widgets.find(c => {
    if (c.model?.type !== 'markdown') return false;
    const tags = c.model.metadata.get ? c.model.metadata.get('tags') : c.model.metadata.tags;
    return Array.isArray(tags) && tags.includes(TAG);
  });

  if (w) {
    const model = w.model;
    if (model && model.sharedModel) {
      if (model.sharedModel.getSource() !== md) {
        model.sharedModel.setSource(md);
      }
    }
    return;
  }

  // If no cell is found, create one
  if (nb.model && nb.model.contentFactory) {
    const factory = nb.model.contentFactory;
    const newCell = factory.createMarkdownCell({
      cell: {
        cell_type: 'markdown',
        source: md,
        metadata: { tags: [TAG] }
      }
    });
    nb.model.cells.insert(0, newCell);
  }
}
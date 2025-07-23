// ---------------------------------------------------------------------------
// @ts-nocheck  – demo：关闭严格 TS 检查
// ---------------------------------------------------------------------------
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { NotebookPanel, INotebookTracker, Notebook } from '@jupyterlab/notebook';
import { MarkdownCellModel } from '@jupyterlab/cells';

/* ------------------------------------------------------------------ */
/* Types & State Management                                           */
/* ------------------------------------------------------------------ */

interface Summary {
  runCnt: number;
  errCnt: number;
  activeMs: number;
}

// In-memory state for each notebook
const panelState = new Map<NotebookPanel, { summary: Summary }>();
const ACTIVITY_INTERVAL_MS = 5000;

/* ------------------------------------------------------------------ */
/* JupyterLab Extension                                               */
/* ------------------------------------------------------------------ */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyter-engagement-final-corrected',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    console.log('[engagement] Activated with final corrected logic.');

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
  
  Promise.all([panel.context.ready, panel.sessionContext.ready]).then(() => {
    if (panelState.has(panel) || panel.isDisposed) {
      return;
    }
    
    console.log(`[attach] Notebook ready, attaching to ${panel.context.path}`);

    const nbMd = panel.content.model.metadata;
    const store = (nbMd.get ? nbMd.get('engage') : nbMd['engage']) ?? {};
    const summary: Summary = store.summary ?? { runCnt: 0, errCnt: 0, activeMs: 0 };
    
    panelState.set(panel, { summary: summary });

    showStoredSummary(panel);

    let activityInterval: number = 0;

    panel.sessionContext.session?.kernel?.anyMessage.connect((_, args) => {
      const msg = args.msg;
      if (msg.header.msg_type === 'execute_input') {
        updateSummary(panel, { addRun: 1 });
        if (!activityInterval) {
            activityInterval = window.setInterval(() => {
                updateSummary(panel, { addMs: ACTIVITY_INTERVAL_MS });
            }, ACTIVITY_INTERVAL_MS);
        }
      } else if (msg.header.msg_type === 'error') {
        updateSummary(panel, { addErr: 1 });
      }
    });

    panel.disposed.connect(() => {
      clearInterval(activityInterval);
      panelState.delete(panel);
      console.log(`[attach] Cleaned up ${panel.context.path}`);
    });

  }).catch(error => {
    console.error(`Failed to attach to notebook ${panel.context.path}:`, error);
  });
}

/* ------------------------------------------------------------------ */
/* Core Logic: Update Model and Mark as Dirty                         */
/* ------------------------------------------------------------------ */

function updateSummary(
  panel: NotebookPanel,
  updates: { addRun?: number; addErr?: number; addMs?: number }
) {
  const state = panelState.get(panel);
  const docModel = panel.content?.model;
  if (!state || !docModel) return;

  // 1. Update the in-memory summary object
  const { summary } = state;
  summary.runCnt += updates.addRun ?? 0;
  summary.errCnt += updates.addErr ?? 0;
  summary.activeMs += updates.addMs ?? 0;
  
  // 2. Update the metadata in the notebook model
  const nbMd = docModel.metadata;
  const store = (nbMd.get ? nbMd.get('engage') : nbMd['engage']) ?? {};
  const newData = { ...store, summary: summary };
  if (nbMd.set) {
    nbMd.set('engage', newData);
  } else {
    nbMd['engage'] = newData;
  }
  
  // 3. Mark the document as dirty to ensure saves work.
  docModel.dirty = true;
  console.log(`%c[update] Model updated and marked as dirty.`, 'color: orange;', summary);
  
  // 4. Update the UI
  updateSummaryUI(panel, summary);
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
    const nb: Notebook = panel.content;
    const TAG = 'engage-summary';
  
    const md = `**Engagement Summary (auto-generated)**

| Metric | Value |
|:---|---:|
| Run count | ${s.runCnt} |
| Error count | ${s.errCnt} |
| Active time (min) | ${Math.round(s.activeMs / 60000)} |`.trim();
  
    // Find the existing cell widget
    const w: any = nb.widgets.find(c => {
      if (c.model?.type !== 'markdown') return false;
      const metadata = c.model.metadata;
      const tags = (metadata.get ? metadata.get('tags') : metadata['tags']) as string[];
      return Array.isArray(tags) && tags.includes(TAG);
    });
  
    // If the cell already exists, just update its content
    if (w) {
      const model = w.model;
      if (model && model.sharedModel) {
        if (model.sharedModel.getSource() !== md) {
          model.sharedModel.setSource(md);
        }
      }
      return;
    }
  
    // If the cell doesn't exist, create it
    if (nb.model) {
      console.log('[summary] Summary cell not found, creating a new one.');
      
      const newCellModel = new MarkdownCellModel({
        metadata: {
          tags: [TAG]
        }
      });
  
      newCellModel.sharedModel.setSource(md);
  
      // Use the robust, version-agnostic insertion logic.
      if (nb.model.cells && nb.model.cells.insert) {
          // This is the modern, preferred way for JupyterLab v3+
          nb.model.cells.insert(0, newCellModel);
      } else if (nb.model.sharedModel && (nb.model.sharedModel as any).insertCell) {
          // This is a fallback for other versions that use the sharedModel for insertion
          (nb.model.sharedModel as any).insertCell(0, {
            cell_type: 'markdown',
            source: md,
            metadata: { tags: [TAG] }
          });
      } else {
          console.warn('[summary] Could not find a method to insert the new cell.');
      }

    } else {
      console.warn('[summary] Notebook model not available, cannot create summary cell.');
    }
  }
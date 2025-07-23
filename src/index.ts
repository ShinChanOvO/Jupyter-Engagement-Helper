// ---------------------------------------------------------------------------
// @ts-nocheck  – demo：关闭严格 TS 检查
// ---------------------------------------------------------------------------
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { NotebookPanel, INotebookTracker, Notebook } from '@jupyterlab/notebook';
import { MarkdownCell, MarkdownCellModel } from '@jupyterlab/cells';

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */
interface Summary {
  runCnt: number;
  errCnt: number;
  activeMs: number;
}

const SUMMARY_CELL_TAG = 'engage-summary';
const ENGAGEMENT_CREDIT_MS = 5000;

/* ------------------------------------------------------------------ */
/* JupyterLab Extension                                               */
/* ------------------------------------------------------------------ */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyter-engagement-parser-logic-final-v2',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    console.log('[engagement] Activated with final double-counting fix.');

    const attachedPanels = new WeakSet<NotebookPanel>();

    // This is the function that sets up each notebook.
    const attach = (panel: NotebookPanel) => {
      // --- FIX for Double-Counting ---
      // Guard and claim the panel immediately to prevent a race condition.
      if (attachedPanels.has(panel) || panel.isDisposed) {
        return;
      }
      attachedPanels.add(panel);

      Promise.all([panel.context.ready, panel.sessionContext.ready]).then(() => {
        if (panel.isDisposed) return;
        
        console.log(`[attach] Attaching listeners to ${panel.context.path}`);
        
        // Load initial data from the UI.
        loadSummaryFromUI(panel); 

        // Listen for kernel events.
        panel.sessionContext.session?.kernel?.anyMessage.connect((_, args) => {
          const msg = args.msg;
          if (msg.header.msg_type === 'execute_input') {
            updateSummary(panel, { addRun: 1, addMs: ENGAGEMENT_CREDIT_MS });
          } else if (msg.header.msg_type === 'error') {
            updateSummary(panel, { addErr: 1, addMs: ENGAGEMENT_CREDIT_MS });
          }
        });

        // Clean up when the notebook is closed.
        panel.disposed.connect(() => {
          // No need to remove from WeakSet, it's handled automatically.
          console.log(`[attach] Cleaned up ${panel.context.path}`);
        });

      }).catch(error => {
        console.error(`[attach] Failed to attach to notebook:`, error);
        attachedPanels.delete(panel); // If setup fails, allow it to be tried again.
      });
    };

    // Set up the triggers for the attach function.
    tracker.widgetAdded.connect((_, panel) => attach(panel));
    app.restored.then(() => {
      tracker.forEach(panel => attach(panel));
    });
  }
};
export default plugin;

/* ------------------------------------------------------------------ */
/* Core Logic: Find, Parse, and Update Summary Cell                   */
/* ------------------------------------------------------------------ */

// In-memory state for each notebook.
const panelState = new Map<NotebookPanel, { summary: Summary }>();

function loadSummaryFromUI(panel: NotebookPanel) {
    const notebook: Notebook = panel.content;
    let summary: Summary = { runCnt: 0, errCnt: 0, activeMs: 0 };
    let cellExists = false;

    // 1. Find the summary cell.
    for (const widget of notebook.widgets) {
        if (widget.model.type === 'markdown') {
            const metadata = widget.model.metadata;
            const tags = (metadata.get ? metadata.get('tags') : metadata['tags']) as string[];
            if (Array.isArray(tags) && tags.includes(SUMMARY_CELL_TAG)) {
                // 2. If found, parse its content.
                const source = (widget.model as MarkdownCellModel).sharedModel.getSource();
                
                const runMatch = source.match(/\| Run count\s*\|\s*(\d+)\s*\|/);
                const errMatch = source.match(/\| Error count\s*\|\s*(\d+)\s*\|/);
                const timeMatch = source.match(/\| Active time \(min\)\s*\|\s*(\d+)\s*\|/);

                if (runMatch && errMatch && timeMatch) {
                    summary.runCnt = parseInt(runMatch[1], 10);
                    summary.errCnt = parseInt(errMatch[1], 10);
                    summary.activeMs = parseInt(timeMatch[1], 10) * 60000; // minutes to ms
                    cellExists = true;
                    console.log(`%c[load] Successfully parsed summary from UI:`, 'color: green; font-weight: bold;', summary);
                }
                break;
            }
        }
    }

    // 3. Store the loaded (or default) data in memory.
    panelState.set(panel, { summary });

    // 4. If the cell didn't exist, create it now.
    if (!cellExists) {
        console.log('[load] Summary cell not found. Creating a new one.');
        updateSummaryUI(panel, summary);
    }
}

function updateSummary(
  panel: NotebookPanel,
  updates: { addRun?: number; addErr?: number; addMs?: number }
) {
  const state = panelState.get(panel);
  const docModel = panel.content?.model;
  if (!state || !docModel) return;

  // Update the in-memory data.
  const { summary } = state;
  summary.runCnt += updates.addRun ?? 0;
  summary.errCnt += updates.addErr ?? 0;
  summary.activeMs += updates.addMs ?? 0;
  
  // Mark the notebook as dirty so it gets saved.
  docModel.dirty = true;
  
  // Update the UI.
  updateSummaryUI(panel, summary);
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
  
    // Find the cell.
    for (const widget of nb.widgets) {
        if (widget.model.type === 'markdown') {
            const metadata = widget.model.metadata;
            const tags = (metadata.get ? metadata.get('tags') : metadata['tags']) as string[];
            if (Array.isArray(tags) && tags.includes(TAG)) {
                // If found, update its content.
                const model = widget.model as MarkdownCellModel;
                if (model.sharedModel.getSource() !== md) {
                    model.sharedModel.setSource(md);
                }
                return;
            }
        }
    }
  
    // If not found, create it using the factory.
    if (nb.model && nb.model.contentFactory) {
        console.log('[UI] Creating new summary cell using content factory.');
        const factory = nb.model.contentFactory;
        const newCell = factory.createMarkdownCell({});
        
        const metadata = newCell.model.metadata;
        if (metadata.set) {
            metadata.set('tags', [TAG]);
        } else {
            metadata['tags'] = [TAG];
        }
        newCell.model.sharedModel.setSource(md);
        
        nb.model.cells.insert(0, newCell.model);
    } else {
        console.warn('[UI] Cannot create cell: content factory not available.');
    }
}
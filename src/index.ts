// @ts-nocheck  – demo：关闭严格 TS 检查
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { NotebookPanel, INotebookTracker, Notebook } from '@jupyterlab/notebook';
import { Cell, MarkdownCell, MarkdownCellModel } from '@jupyterlab/cells';

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */
interface Summary {
  runCnt: number;
  errCnt: number;
  activeMs: number;
  markdownActiveMs: number;
  uniqueCellsExecuted: number;
}

interface PanelState {
  summary: Summary;
  markdownFocusStartTs: number | null;
  lastError: { cellId: string, timestamp: number } | null;
  executedCells: Set<string>;
}

const SUMMARY_CELL_TAG = 'engage-summary';
const ENGAGEMENT_CREDIT_MS = 5000;

/* ------------------------------------------------------------------ */
/* JupyterLab Extension                                               */
/* ------------------------------------------------------------------ */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyter-engagement-final-corrected',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    console.log('[engagement] Activated with final corrected logic.');

    // This WeakSet keeps track of notebooks we've already attached to.
    const attachedPanels = new WeakSet<NotebookPanel>();

    const attach = (panel: NotebookPanel) => {
      // --- FIX for Double-Counting ---
      // If we have already attached to this panel, do nothing.
      if (attachedPanels.has(panel) || panel.isDisposed) {
        return;
      }
      // "Claim" this panel immediately to prevent other events from re-attaching.
      attachedPanels.add(panel);

      Promise.all([panel.context.ready, panel.sessionContext.ready]).then(() => {
        if (panel.isDisposed) return;
        
        console.log(`[attach] Attaching listeners to ${panel.context.path}`);
        
        loadSummaryFromUI(panel); 

        panel.content.activeCellChanged.connect((notebook, activeCell) => {
            handleActiveCellChange(panel, activeCell);
        });

        panel.sessionContext.session?.kernel?.anyMessage.connect((_, args) => {
          const msg = args.msg;
          const activeCell = panel.content.activeCell;
          if (!activeCell) return;
          
          if (msg.header.msg_type === 'execute_input') {
            handleCellRun(panel, activeCell);
          } else if (msg.header.msg_type === 'error') {
            handleCellError(panel, activeCell);
          }
        });

        panel.disposed.connect(() => {
          // No need to remove from WeakSet, it's handled automatically
          console.log(`[attach] Cleaned up ${panel.context.path}`);
        });

      }).catch(error => {
        console.error(`[attach] Failed to attach:`, error);
        attachedPanels.delete(panel); // If setup fails, allow a retry
      });
    };

    // Call attach for newly opened and restored notebooks.
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

const panelState = new Map<NotebookPanel, PanelState>();

function findOrCreateSummaryCell(notebook: Notebook): MarkdownCell | null {
  for (const widget of notebook.widgets) {
    if (widget.model.type === 'markdown') {
        const metadata = widget.model.metadata;
        const tags = (metadata.get ? metadata.get('tags') : metadata['tags']) as string[];
        if (Array.isArray(tags) && tags.includes(SUMMARY_CELL_TAG)) {
            return widget as MarkdownCell;
        }
    }
  }
  return null;
}

function updateSummaryUI(panel: NotebookPanel) {
    const state = panelState.get(panel);
    const nb: Notebook = panel.content;
    if (!state || !nb.model) return;

    const { summary } = state;

    let totalCodeCellCount = 0;
    for (let i = 0; i < nb.model.cells.length; i++) {
        if (nb.model.cells.get(i).type === 'code') {
            totalCodeCellCount++;
        }
    }

    const progress = totalCodeCellCount > 0 ? Math.round((summary.uniqueCellsExecuted / totalCodeCellCount) * 100) : 0;
    
    const md = `**Engagement Summary (auto-generated)**

| Metric | Value |
|:---|---:|
| Run count | ${summary.runCnt} |
| Error count | ${summary.errCnt} |
| Active time (min) | ${Math.round(summary.activeMs / 60000)} |
| Markdown Reading (min) | ${Math.round(summary.markdownActiveMs / 60000)} |
| Unique Cells Run | ${summary.uniqueCellsExecuted} |
| Progress Completion | ${progress}% |`.trim();
  
    let summaryCellWidget = findOrCreateSummaryCell(nb);
    
    if (!summaryCellWidget) {
        console.log('[UI] Summary cell not found, creating one.');
        const newCellModel = new MarkdownCellModel({ metadata: { tags: [SUMMARY_CELL_TAG] } });
        newCellModel.sharedModel.setSource(md);

        if (nb.model.cells && nb.model.cells.insert) {
            nb.model.cells.insert(0, newCellModel);
        } else if (nb.model.sharedModel && (nb.model.sharedModel as any).insertCell) {
            (nb.model.sharedModel as any).insertCell(0, {
              cell_type: 'markdown',
              source: md,
              metadata: { tags: [SUMMARY_CELL_TAG] }
            });
        } else {
            console.warn('[UI] Could not find a method to insert the new cell.');
            return;
        }
        summaryCellWidget = findOrCreateSummaryCell(nb);
    }
    
    if (summaryCellWidget) {
        const model = summaryCellWidget.model as MarkdownCellModel;
        if (model.sharedModel.getSource() !== md) {
            model.sharedModel.setSource(md);
        }
        nb.model.dirty = true;
    }
}

function loadSummaryFromUI(panel: NotebookPanel) {
    let summary: Summary = { runCnt: 0, errCnt: 0, activeMs: 0, markdownActiveMs: 0, uniqueCellsExecuted: 0 };
    let cellExists = false;

    const summaryCell = findOrCreateSummaryCell(panel.content);
    if (summaryCell) {
        const source = summaryCell.model.sharedModel.getSource();
        const runMatch = source.match(/\| Run count\s*\|\s*(\d+)\s*\|/);
        const errMatch = source.match(/\| Error count\s*\|\s*(\d+)\s*\|/);
        const activeTimeMatch = source.match(/\| Active time \(min\)\s*\|\s*(\d+)\s*\|/);
        const markdownTimeMatch = source.match(/\| Markdown Reading \(min\)\s*\|\s*(\d+)\s*\|/);
        const uniqueCellsMatch = source.match(/\| Unique Cells Run\s*\|\s*(\d+)\s*\|/);

        if (runMatch) summary.runCnt = parseInt(runMatch[1], 10);
        if (errMatch) summary.errCnt = parseInt(errMatch[1], 10);
        if (activeTimeMatch) summary.activeMs = parseInt(activeTimeMatch[1], 10) * 60000;
        if (markdownTimeMatch) summary.markdownActiveMs = parseInt(markdownTimeMatch[1], 10) * 60000;
        if (uniqueCellsMatch) summary.uniqueCellsExecuted = parseInt(uniqueCellsMatch[1], 10);
        
        if (runMatch) {
            cellExists = true;
            console.log(`%c[load] Successfully parsed summary from UI:`, 'color: green; font-weight: bold;', summary);
        }
    }
    
    panelState.set(panel, { 
        summary,
        markdownFocusStartTs: null,
        lastError: null,
        executedCells: new Set() 
    });

    updateSummaryUI(panel);
}

function handleActiveCellChange(panel: NotebookPanel, newActiveCell: Cell) {
    const state = panelState.get(panel);
    if (!state) return;

    if (state.markdownFocusStartTs) {
        const duration = Date.now() - state.markdownFocusStartTs;
        state.summary.markdownActiveMs += duration;
    }

    if (newActiveCell && newActiveCell.model.type === 'markdown') {
        state.markdownFocusStartTs = Date.now();
    } else {
        state.markdownFocusStartTs = null;
    }

    updateSummaryUI(panel);
}

function handleCellRun(panel: NotebookPanel, cell: Cell) {
    const state = panelState.get(panel);
    if (!state) return;
    
    if (state.lastError && state.lastError.cellId === cell.model.id) {
        const resolutionTime = Date.now() - state.lastError.timestamp;
        console.log(`%c[metrics] Error resolved in ${Math.round(resolutionTime/1000)}s.`, 'color: purple;');
        state.lastError = null;
    }

    state.executedCells.add(cell.model.id);
    state.summary.uniqueCellsExecuted = state.executedCells.size;
    state.summary.runCnt++;
    state.summary.activeMs += ENGAGEMENT_CREDIT_MS;
    
    updateSummaryUI(panel);
}

function handleCellError(panel: NotebookPanel, cell: Cell) {
    const state = panelState.get(panel);
    if (!state) return;

    state.lastError = { cellId: cell.model.id, timestamp: Date.now() };
    console.log(`%c[metrics] Error detected in cell ${cell.model.id.slice(0,5)}.`, 'color: red;');

    state.summary.errCnt++;
    state.summary.activeMs += ENGAGEMENT_CREDIT_MS;
    
    updateSummaryUI(panel);
}
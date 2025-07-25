// ---------------------------------------------------------------------------
// @ts-nocheck  – demo：关闭严格 TS 检查
// ---------------------------------------------------------------------------
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
  id: 'jupyter-engagement-full-persistence-final',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    console.log('[engagement] Activated with full persistence logic.');

    const attachedPanels = new WeakSet<NotebookPanel>();

    const attach = (panel: NotebookPanel) => {
      if (attachedPanels.has(panel) || panel.isDisposed) return;
      
      Promise.all([panel.context.ready, panel.sessionContext.ready]).then(() => {
        if (panel.isDisposed) return;
        
        console.log(`[attach] Attaching to ${panel.context.path}`);
        attachedPanels.add(panel);
        
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

        panel.disposed.connect(() => attachedPanels.delete(panel) );

      }).catch(error => {
        console.error(`[attach] Failed to attach:`, error);
      });
    };

    tracker.widgetAdded.connect((_, panel) => attach(panel));
    app.restored.then(() => {
      tracker.forEach(panel => attach(panel));
    });
  }
};
export default plugin;

/* ------------------------------------------------------------------ */
/* State and UI Management (Helper functions defined first)           */
/* ------------------------------------------------------------------ */

// In-memory state for each notebook.
const panelState = new Map<NotebookPanel, PanelState>();

/**
 * Finds the summary cell. If it doesn't exist, creates it and inserts it
 * at the top of the notebook.
 * @returns The MarkdownCell widget for the summary.
 */
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
  console.log('[UI] Summary cell not found, creating one.');
  if (notebook.model && notebook.model.contentFactory) {
      const factory = notebook.model.contentFactory;
      const newCell = factory.createMarkdownCell({});
      const metadata = newCell.model.metadata;
      if (metadata.set) metadata.set('tags', [SUMMARY_CELL_TAG]);
      else metadata['tags'] = [SUMMARY_CELL_TAG];
      notebook.model.cells.insert(0, newCell.model);
      return newCell;
  }
  return null;
}

/**
 * Renders the data from memory into the summary cell's markdown table.
 */
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
  
    const summaryCell = findOrCreateSummaryCell(nb);
    if (summaryCell) {
        const model = summaryCell.model as MarkdownCellModel;
        if (model.sharedModel.getSource() !== md) {
            model.sharedModel.setSource(md);
        }
        nb.model.dirty = true;
    }
}

/* ------------------------------------------------------------------ */
/* Core Logic & Event Handlers (Main logic that uses helpers)         */
/* ------------------------------------------------------------------ */

/**
 * On startup, this reads the data from the UI to populate the initial state.
 */
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
        
        // Check if the cell we found actually contained data.
        if (runMatch && errMatch && activeTimeMatch) {
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

    if (!cellExists) {
        console.log('[load] Summary cell not found or was empty. Creating/updating.');
        updateSummaryUI(panel);
    }
}

/**
 * Handles changes in the active cell to track time spent on markdown.
 */
function handleActiveCellChange(panel: NotebookPanel, newActiveCell: Cell) {
    const state = panelState.get(panel);
    if (!state) return;

    if (state.markdownFocusStartTs) {
        const duration = Date.now() - state.markdownFocusStartTs;
        state.summary.markdownActiveMs += duration;
        console.log(`[metrics] Added ${Math.round(duration/1000)}s to Markdown time.`);
    }

    if (newActiveCell && newActiveCell.model.type === 'markdown') {
        state.markdownFocusStartTs = Date.now();
    } else {
        state.markdownFocusStartTs = null;
    }

    updateSummaryUI(panel);
}

/**
 * Handles a successful cell execution.
 */
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

/**
 * Handles an error during cell execution.
 */
function handleCellError(panel: NotebookPanel, cell: Cell) {
    const state = panelState.get(panel);
    if (!state) return;

    state.lastError = { cellId: cell.model.id, timestamp: Date.now() };
    console.log(`%c[metrics] Error detected in cell ${cell.model.id.slice(0,5)}.`, 'color: red;');

    state.summary.errCnt++;
    state.summary.activeMs += ENGAGEMENT_CREDIT_MS;
    
    updateSummaryUI(panel);
}
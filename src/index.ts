// -----------------------------------------------------------------------------
// @ts-nocheck     – the plugin is small and we relax full-strict typing here
// -----------------------------------------------------------------------------

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  NotebookPanel,
  INotebookTracker
} from '@jupyterlab/notebook';

import { MarkdownCell } from '@jupyterlab/cells';          // for run-time update

/* -------------------------------------------------------------------------- */
/*  Types & global buffer                                                     */
/* -------------------------------------------------------------------------- */
interface EngageEvent {
  ts: number;                       // Unix epoch (ms)
  evt: 'open' | 'runCell' | 'error';
  nb:  string;                      // notebook path
  cell?:  number;                   // execution counter
  ename?: string;                   // error name
}
const buffer: EngageEvent[] = [];
let   lastFlush = 0;

/* -------------------------------------------------------------------------- */
/*  JupyterLab plugin                                                         */
/* -------------------------------------------------------------------------- */
const plugin: JupyterFrontEndPlugin<void> = {
  id:        'jupyter-engagement-helper',
  autoStart: true,
  requires:  [INotebookTracker],
  activate:  (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    console.log('[plugin] activated', Date.now());

    /* A ─ notebooks already restored when Lab starts */
    tracker.restored.then(() => {
      console.log('[plugin] tracker.restored');
      tracker.forEach((p: NotebookPanel) =>
        p.sessionContext.ready.then(() => attachHandlers(p))
      );
    });

    /* B ─ notebooks opened afterwards */
    tracker.widgetAdded.connect((_s, p) =>
      p.sessionContext.ready.then(() => attachHandlers(p))
    );

    /* C ─ user switches tabs */
    tracker.currentChanged.connect((_s, p) => {
      if (p) p.sessionContext.ready.then(() => attachHandlers(p));
    });

    window.addEventListener('beforeunload', flush);
  }
};
export default plugin;

/* -------------------------------------------------------------------------- */
/*  Attach handlers to one notebook panel                                     */
/* -------------------------------------------------------------------------- */
function attachHandlers(panel: NotebookPanel): void {
  const nbPath = panel.context.path;
  console.log('[attach] on', nbPath);
  Private.currentPanel = panel;

  /* 1 ─ record “open” (once model ready) */
  panel.context.ready.then(() => {
    log({ ts: Date.now(), evt: 'open', nb: nbPath });
    flush();                              // first write
  });

  /* 2 ─ kernel messages → run / error events */
  panel.sessionContext.session?.kernel?.anyMessage?.connect((_s, args) => {
    const msg = (args as any).msg;
    if (!msg?.header) return;

    const t = Date.now();
    if (msg.header.msg_type === 'execute_input') {
      log({ ts: t, evt: 'runCell', nb: nbPath,
            cell: msg.content.execution_count });
    } else if (msg.header.msg_type === 'error') {
      log({ ts: t, evt: 'error', nb: nbPath,
            cell: msg.parent_header?.content?.execution_count,
            ename: msg.content.ename });
    }
  });

  /* 3 ─ ensure summary cell insertion after UI fully rendered */
  panel.revealed.then(() => requestAnimationFrame(flush));
}

/* -------------------------------------------------------------------------- */
/*  Buffer helpers                                                            */
/* -------------------------------------------------------------------------- */
function log(e: EngageEvent): void {
  buffer.push(e);
  if (buffer.length >= 200 || Date.now() - lastFlush > 5_000) flush();
}

/* -------------------------------------------------------------------------- */
/*  Persist events → notebook metadata & update summary cell                 */
/* -------------------------------------------------------------------------- */
function flush(): void {
  if (!buffer.length || !Private.currentPanel) return;

  const panel      = Private.currentPanel;
  const nbWidget   = panel.content;                     // Notebook widget
  const nbModel: any = nbWidget.model;                  // INotebookModel

  if (!nbModel?.sharedModel) return;                    // still not ready

  /* -- 1. merge & store events in metadata -------------------------------- */
  const metaObj: any = nbModel?.metadata as any;
  const prev    = metaObj?.get ? metaObj.get('engage') ?? {}
                               : metaObj.engage ?? {};
  const merged  = [...(prev.events ?? []), ...buffer].slice(-5000);

  if (metaObj?.set) metaObj.set('engage', { ...prev, events: merged });
  else              metaObj.engage =        { ...prev, events: merged };

  console.log('[flush] wrote', merged.length, 'events');
  buffer.length = 0;
  lastFlush     = Date.now();

  /* -- 2. compute summary numbers ----------------------------------------- */
  const summary = {
    runCnt: merged.filter(e => e.evt === 'runCell').length,
    errCnt: merged.filter(e => e.evt === 'error').length,
    activeMs:
      merged.length ? merged[merged.length - 1].ts - merged[0].ts : 0
  };

  updateSummary(nbWidget, nbModel, summary);
}

/* -------------------------------------------------------------------------- */
/*  Create / refresh the single summary markdown cell                         */
/* -------------------------------------------------------------------------- */
function updateSummary(
  nbWidget: any,
  nbModel:  any,
  s: { runCnt: number; errCnt: number; activeMs: number }
): void {
  const TAG = 'engage-summary';

  /* a) locate existing summary cell (by tag) ------------------------------ */
  let mdCell: MarkdownCell | undefined = nbWidget.widgets.find((w: any) => {
    if (w.model?.type !== 'markdown') return false;
    const tgs: string[] = w.model?.sharedModel?.getMetadata('tags') ?? [];
    return Array.isArray(tgs) && tgs.includes(TAG);
  });

  const mdSource = `
<!-- auto -->
**Engagement Summary (auto-generated)**

| Metric | Value |
|--------|-------|
| Run count        | ${s.runCnt} |
| Error count      | ${s.errCnt} |
| Active time (min)| ${Math.round(s.activeMs / 60000)} |
`.trim();

  /* b) update existing ---------------------------------------------------- */
  if (mdCell) {
    mdCell.model.sharedModel.setSource(mdSource);
    return;
  }

  /* c) insert new markdown cell at top (sharedModel API, JL ≥ 4.x) -------- */
  nbModel.sharedModel.insertCells(0, [
    {
      cell_type: 'markdown',
      source: mdSource,
      metadata: { tags: [TAG, 'hide_input', 'hide_output'] }
    }
  ]);

  console.log('[summary] inserted new summary cell');
}

/* -------------------------------------------------------------------------- */
/*  Private state                                                             */
/* -------------------------------------------------------------------------- */
namespace Private {
  export let currentPanel: NotebookPanel | null = null;
}

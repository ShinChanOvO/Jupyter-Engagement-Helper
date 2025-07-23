// @ts-nocheck
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { NotebookPanel, INotebookTracker } from '@jupyterlab/notebook';
import { MarkdownCell } from '@jupyterlab/cells';

/* ------------------------------------------------------------------ */
/*  Types & global buffer                                              */
/* ------------------------------------------------------------------ */
interface EngageEvent {
  ts: number;                         // Unix epoch (ms)
  evt: 'open' | 'runCell' | 'error';  // event kind
  nb: string;                         // notebook path
  cell?: number;                      // exec counter
  ename?: string;                     // error name
}
const buffer: EngageEvent[] = [];
let lastFlush = 0;

/* ------------------------------------------------------------------ */
/*  JupyterLab plugin                                                  */
/* ------------------------------------------------------------------ */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyter-engagement-helper',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    console.log('[plugin] activated');
    console.log('[plugin] build-stamp', Date.now());

    /* A) notebooks already open when workspace is restored */
    tracker.restored.then(() => {
      console.log('[plugin] tracker.restored');
      tracker.forEach((panel: NotebookPanel) => {
        panel.sessionContext.ready.then(() => attachHandlers(panel));
      });
    });

    /* B) notebooks opened after activation */
    tracker.widgetAdded.connect((_s, panel) => {
      console.log('[plugin] widgetAdded', panel.context.path);
      panel.sessionContext.ready.then(() => attachHandlers(panel));
    });

    /* C) update currentPanel when user switches tabs */
    tracker.currentChanged.connect((_s, panel) => {
      if (panel) {
        console.log('[plugin] currentChanged', panel.context.path);
        panel.sessionContext.ready.then(() => attachHandlers(panel));
      }
    });

    window.addEventListener('beforeunload', flush);
  }
};
export default plugin;

/* ------------------------------------------------------------------ */
/*  Attach listeners to one notebook panel                             */
/* ------------------------------------------------------------------ */
function attachHandlers(panel: NotebookPanel) {
  const nbPath = panel.context.path;
  console.log('[attach] on', nbPath);
  Private.currentPanel = panel;

  /* record “open” once the model is ready */
  panel.context.ready.then(() => {
    log({ ts: Date.now(), evt: 'open', nb: nbPath });
    flush();                                 // force first write
  });

  /* listen for kernel messages */
  panel.sessionContext.session?.kernel?.anyMessage?.connect((_s, args) => {
    const m = (args as any).msg;             // actual kernel message
    if (!m || !m.header) return;

    const t = Date.now();
    if (m.header.msg_type === 'execute_input') {
      log({ ts: t, evt: 'runCell', nb: nbPath, cell: m.content.execution_count });
    } else if (m.header.msg_type === 'error') {
      log({
        ts: t,
        evt: 'error',
        nb: nbPath,
        cell: m.parent_header?.content?.execution_count,
        ename: m.content.ename
      });
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Buffer helper                                                      */
/* ------------------------------------------------------------------ */
function log(e: EngageEvent) {
  buffer.push(e);
  console.log('[log] push', e);
  if (buffer.length >= 200 || Date.now() - lastFlush > 5_000) {
    flush();
  }
}

/* ------------------------------------------------------------------ */
/*  Persist events into notebook metadata                              */
/* ------------------------------------------------------------------ */
function flush() {
  if (!buffer.length || !Private.currentPanel) return;

  const panel = Private.currentPanel;
  const model = panel.content?.model;
  if (!model || !model.metadata) return;     // model not ready

  const meta: any = model.metadata;
  const useGet = typeof meta.get === 'function';
  const prev   = useGet ? meta.get('engage') ?? {} : meta.engage ?? {};

  const merged = [...(prev.events ?? []), ...buffer].slice(-5000);

  if (useGet) meta.set('engage', { ...prev, events: merged });
  else        meta.engage = { ...prev, events: merged };

  console.log('[flush] wrote', merged.length, 'events');

  /* summary numbers */
  const summary = {
    runCnt: merged.filter(e => e.evt === 'runCell').length,
    errCnt: merged.filter(e => e.evt === 'error').length,
    activeMs: merged.length ? merged[merged.length - 1].ts - merged[0].ts : 0
  };
  updateSummaryCell(panel, summary);

  buffer.length = 0;
  lastFlush = Date.now();
}

/* ------------------------------------------------------------------ */
/*  Insert / refresh summary markdown                                 */
/* ------------------------------------------------------------------ */
function updateSummaryCell(
  panel: NotebookPanel,
  s: { runCnt: number; errCnt: number; activeMs: number }
) {
  const nb   = panel.content;
  const TAG  = 'engage-summary';

  /* locate existing summary cell (metadata may be plain object) */
  let cell = nb.widgets.find(w => {
    if (w.model?.type !== 'markdown') return false;
    const meta: any     = w.model.metadata;
    const tags: string[] =
      typeof meta.get === 'function' ? meta.get('tags') : meta.tags;
    return Array.isArray(tags) && tags.includes(TAG);
  }) as MarkdownCell | undefined;

  const md = `
<!-- auto -->
**Engagement Summary (auto-generated)**

| Metric | Value |
|--------|-------|
| Run count | ${s.runCnt} |
| Error count | ${s.errCnt} |
| Active time (min) | ${Math.round(s.activeMs / 60000)} |
`.trim();

  if (cell) {
    cell.model!.value.text = md;            // refresh
  } else {
 // ----- create markdown cell (factory may be undefined at first launch) -----
const model: any = nb.model;
const factory: any =
  model?.contentFactory ??   // ≤ 4.1
  model?.factory ??          // ≥ 4.2
  null;

if (!factory || !factory.createMarkdownCell) {
  console.warn('[summary] factory still missing; will try later');
  return;                    // wait for next flush
}

const m = factory.createMarkdownCell({});


    m.value.text = md;
    m.metadata.set('tags', [TAG, 'hide_input', 'hide_output']);
    nb.model!.cells.insert(0, m);           // put at top
  }
}

/* ------------------------------------------------------------------ */
/*  Private namespace                                                  */
/* ------------------------------------------------------------------ */
namespace Private {
  export let currentPanel: NotebookPanel | null = null;
}
